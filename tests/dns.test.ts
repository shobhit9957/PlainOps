import { describe, it, expect } from 'vitest';
import { isValidDomain, bestZoneMatch, r53Change } from '../src/dns.js';

describe('isValidDomain', () => {
  it('accepts real domains and rejects junk', () => {
    expect(isValidDomain('mydatingapp.com')).toBe(true);
    expect(isValidDomain('app.my-dating-app.co.in')).toBe(true);
    expect(isValidDomain('APP.Example.COM')).toBe(true);
    expect(isValidDomain('localhost')).toBe(false);
    expect(isValidDomain('http://example.com')).toBe(false);
    expect(isValidDomain('exam ple.com')).toBe(false);
    expect(isValidDomain('-bad.example.com')).toBe(false);
    expect(isValidDomain('')).toBe(false);
  });
});

describe('bestZoneMatch', () => {
  const zones = [{ name: 'example.com.' }, { name: 'shop.example.com.' }, { name: 'other.io.' }];
  it('picks the longest matching suffix zone', () => {
    expect(bestZoneMatch('app.shop.example.com', zones)?.name).toBe('shop.example.com.');
    expect(bestZoneMatch('www.example.com', zones)?.name).toBe('example.com.');
    expect(bestZoneMatch('example.com', zones)?.name).toBe('example.com.');
  });
  it('never matches a lookalike suffix (notexample.com ≠ example.com)', () => {
    expect(bestZoneMatch('notexample.com', zones)).toBeNull();
    expect(bestZoneMatch('example.com.evil.net', zones)).toBeNull();
  });
  it('returns null when nothing covers the domain', () => {
    expect(bestZoneMatch('unrelated.dev', zones)).toBeNull();
  });
});

describe('r53Change', () => {
  it('builds a plain UPSERT record', () => {
    const batch = JSON.parse(r53Change('_abc.example.com.', 'CNAME', '_xyz.acm-validations.aws.'));
    expect(batch.Changes[0].Action).toBe('UPSERT');
    expect(batch.Changes[0].ResourceRecordSet).toMatchObject({
      Name: '_abc.example.com.',
      Type: 'CNAME',
      TTL: 300,
      ResourceRecords: [{ Value: '_xyz.acm-validations.aws.' }],
    });
  });
  it('builds an ALIAS record when a zone id is given', () => {
    const batch = JSON.parse(r53Change('example.com', 'A', 'my-alb.ap-south-1.elb.amazonaws.com', 'ZP97RAFLXTNZK'));
    const rr = batch.Changes[0].ResourceRecordSet;
    expect(rr.AliasTarget).toMatchObject({ HostedZoneId: 'ZP97RAFLXTNZK', DNSName: 'my-alb.ap-south-1.elb.amazonaws.com' });
    expect(rr.TTL).toBeUndefined();
  });
});

describe('gcpRecordSets (Cloud DNS publishing plan)', () => {
  it('uses the mapped domain itself as the record name — never a doubled label', async () => {
    const { gcpRecordSets } = await import('../src/dns.js');
    // Cloud Run returns name:'app' for a mapping of app.example.com; appending
    // it to the mapped domain produced app.app.example.com in the old code.
    const sets = gcpRecordSets('app.example.com', [{ name: 'app', type: 'CNAME', rrdata: 'ghs.googlehosted.com.' }]);
    expect(sets).toEqual([{ name: 'app.example.com.', type: 'CNAME', rrdatas: ['ghs.googlehosted.com.'] }]);
  });
  it('groups every apex A/AAAA rrdata into ONE record-set per type', async () => {
    const { gcpRecordSets } = await import('../src/dns.js');
    const records = [
      { type: 'A', rrdata: '216.239.32.21' },
      { type: 'A', rrdata: '216.239.34.21' },
      { type: 'A', rrdata: '216.239.36.21' },
      { type: 'A', rrdata: '216.239.38.21' },
      { type: 'AAAA', rrdata: '2001:4860:4802:32::15' },
      { type: 'AAAA', rrdata: '2001:4860:4802:34::15' },
    ];
    const sets = gcpRecordSets('example.com', records);
    expect(sets).toHaveLength(2);
    const a = sets.find((s) => s.type === 'A')!;
    expect(a.name).toBe('example.com.');
    expect(a.rrdatas).toHaveLength(4);
    const aaaa = sets.find((s) => s.type === 'AAAA')!;
    expect(aaaa.rrdatas).toHaveLength(2);
  });
});

describe('azureRecordPlan (apex vs subdomain)', () => {
  it('apex: A record at @, validation TXT is "asuid" — never "asuid.@"', async () => {
    const { azureRecordPlan } = await import('../src/dns.js');
    const plan = azureRecordPlan('example.com', 'example.com');
    expect(plan).toEqual({ apex: true, recordName: '@', asuidName: 'asuid' });
  });
  it('subdomain: CNAME at the sub label with asuid.<sub>', async () => {
    const { azureRecordPlan } = await import('../src/dns.js');
    const plan = azureRecordPlan('app.example.com', 'example.com.');
    expect(plan).toEqual({ apex: false, recordName: 'app', asuidName: 'asuid.app' });
  });
});

describe('recordSetName (apex vs subdomain)', () => {
  it('returns @ at the zone apex — never the full domain', async () => {
    const { recordSetName } = await import('../src/dns.js');
    expect(recordSetName('example.com', 'example.com')).toBe('@');
    expect(recordSetName('example.com.', 'example.com')).toBe('@');
    expect(recordSetName('EXAMPLE.com', 'example.com.')).toBe('@');
  });
  it('strips only the zone suffix for subdomains', async () => {
    const { recordSetName } = await import('../src/dns.js');
    expect(recordSetName('app.example.com', 'example.com')).toBe('app');
    expect(recordSetName('api.staging.example.com', 'example.com.')).toBe('api.staging');
    expect(recordSetName('api.staging.example.com', 'staging.example.com')).toBe('api');
  });
});
