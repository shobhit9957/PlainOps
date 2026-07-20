import { EC2Client, DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import { ECSClient, ListClustersCommand, ListServicesCommand, DescribeServicesCommand } from '@aws-sdk/client-ecs';
import { S3Client, ListBucketsCommand } from '@aws-sdk/client-s3';

/**
 * Read-only AWS inventory so the founder can ask "what's running in my account?"
 * Never mutates anything.
 */

export interface AwsInventory {
  region: string;
  ec2: Array<{ id: string; name: string; type: string; state: string }>;
  ecsServices: Array<{ cluster: string; service: string; running: number; desired: number }>;
  staticSites: string[];
}

export async function inspectAws(region: string): Promise<AwsInventory> {
  const [ec2, ecsServices, staticSites] = await Promise.all([
    listEc2(region),
    listEcsServices(region),
    listStaticSiteBuckets(region),
  ]);
  return { region, ec2, ecsServices, staticSites };
}

async function listEc2(region: string) {
  const ec2 = new EC2Client({ region });
  const res = await ec2.send(new DescribeInstancesCommand({}));
  const out: AwsInventory['ec2'] = [];
  for (const r of res.Reservations ?? []) {
    for (const i of r.Instances ?? []) {
      out.push({
        id: i.InstanceId ?? '?',
        name: i.Tags?.find((t) => t.Key === 'Name')?.Value ?? '(unnamed)',
        type: i.InstanceType ?? '?',
        state: i.State?.Name ?? '?',
      });
    }
  }
  return out;
}

async function listEcsServices(region: string) {
  const ecs = new ECSClient({ region });
  const out: AwsInventory['ecsServices'] = [];
  const clusters = await ecs.send(new ListClustersCommand({}));
  for (const clusterArn of clusters.clusterArns ?? []) {
    const svcList = await ecs.send(new ListServicesCommand({ cluster: clusterArn }));
    if (!svcList.serviceArns?.length) continue;
    const described = await ecs.send(new DescribeServicesCommand({ cluster: clusterArn, services: svcList.serviceArns }));
    for (const s of described.services ?? []) {
      out.push({
        cluster: clusterArn.split('/').pop() ?? clusterArn,
        service: s.serviceName ?? '?',
        running: s.runningCount ?? 0,
        desired: s.desiredCount ?? 0,
      });
    }
  }
  return out;
}

async function listStaticSiteBuckets(region: string) {
  const s3 = new S3Client({ region });
  const res = await s3.send(new ListBucketsCommand({}));
  return (res.Buckets ?? [])
    .map((b) => b.Name!)
    .filter((n) => n.startsWith('plainops-site-'));
}
