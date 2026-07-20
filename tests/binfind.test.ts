import { describe, it, expect } from 'vitest';
import { findBinary, wellKnownLocations } from '../src/binfind.js';

/**
 * The two real-world failures this module exists for:
 *  - Windows: stale PATH (CLI installed machine-wide after the shell/app
 *    started) — hit live: `where gcloud` failed while gcloud.cmd sat in
 *    Program Files (x86).
 *  - macOS: GUI-launched apps get launchd's minimal PATH without
 *    /opt/homebrew/bin — terminal finds the CLI, the desktop app doesn't.
 */

describe('wellKnownLocations', () => {
  it('covers the official installer paths on Windows (both Program Files flavors)', () => {
    const gcloud = wellKnownLocations('gcloud', 'win32', 'C:\\Users\\f');
    expect(gcloud).toContain('C:\\Program Files (x86)\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud.cmd');
    expect(gcloud).toContain('C:\\Program Files\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud.cmd');
    expect(wellKnownLocations('az', 'win32', 'C:\\Users\\f')[0]).toBe('C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd');
    expect(wellKnownLocations('aws', 'win32', 'C:\\Users\\f')[0]).toBe('C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe');
  });

  it('covers Homebrew (Apple Silicon AND Intel prefixes) plus the official SDK dir on macOS', () => {
    for (const tool of ['aws', 'gcloud', 'az'] as const) {
      const locs = wellKnownLocations(tool, 'darwin', '/Users/f');
      expect(locs.some((l) => l.startsWith('/opt/homebrew/'))).toBe(true);
      expect(locs.some((l) => l.startsWith('/usr/local/'))).toBe(true);
    }
    expect(wellKnownLocations('gcloud', 'darwin', '/Users/f')).toContain('/Users/f/google-cloud-sdk/bin/gcloud');
  });

  it('covers apt/snap/installer locations on Linux', () => {
    expect(wellKnownLocations('gcloud', 'linux', '/home/f')).toContain('/snap/bin/gcloud');
    expect(wellKnownLocations('aws', 'linux', '/home/f')).toContain('/usr/local/bin/aws');
  });
});

describe('findBinary', () => {
  it('prefers PATH when the lookup succeeds', () => {
    const found = findBinary('aws', {
      platform: 'darwin',
      pathLookup: () => ['/somewhere/aws'],
      exists: () => {
        throw new Error('must not probe when PATH answered');
      },
    });
    expect(found).toBe('/somewhere/aws');
  });

  it('Windows: prefers the .cmd shim among PATH hits for batch CLIs', () => {
    const found = findBinary('gcloud', {
      platform: 'win32',
      preferShim: true,
      pathLookup: () => ['C:\\sdk\\bin\\gcloud', 'C:\\sdk\\bin\\gcloud.cmd'],
    });
    expect(found).toBe('C:\\sdk\\bin\\gcloud.cmd');
  });

  it('falls back to the official install locations when PATH is empty (the GUI-PATH case)', () => {
    const found = findBinary('gcloud', {
      platform: 'darwin',
      home: '/Users/f',
      pathLookup: () => null, // launchd PATH: no Homebrew
      exists: (p) => p === '/opt/homebrew/bin/gcloud',
    });
    expect(found).toBe('/opt/homebrew/bin/gcloud');
  });

  it('falls back to Program Files on Windows when `where` finds nothing (the stale-PATH case)', () => {
    const found = findBinary('az', {
      platform: 'win32',
      pathLookup: () => null,
      exists: (p) => p === 'C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd',
    });
    expect(found).toBe('C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd');
  });

  it('returns null only when the tool is truly absent', () => {
    expect(findBinary('az', { platform: 'darwin', pathLookup: () => null, exists: () => false })).toBeNull();
  });
});
