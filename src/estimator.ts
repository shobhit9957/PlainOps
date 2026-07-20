export type Region = 'us-east-1' | 'ap-south-1';

export interface BlueprintParams {
  projectName: string;
  region: Region;
  cpu: 256 | 512 | 1024; // Fargate CPU units (256 = 0.25 vCPU)
  memoryMb: 512 | 1024 | 2048;
  desiredCount: number;
  maxCount: number;
  withDatabase: boolean;
  healthPath: string;
  containerPort: number;
  appSecrets: string[];
  budgetEmail?: string;
  budgetMonthlyUsd: number;
}

export interface EstimateLine {
  item: string;
  monthly: number;
}

export interface Estimate {
  monthly: number;
  daily: number;
  yearly: number;
  lines: EstimateLine[];
  disclaimer: string;
}

const HOURS_PER_MONTH = 730;

/** USD hourly/fixed prices per region. Hand-maintained for blueprint resources only. */
const PRICES: Record<Region, {
  fargateVcpuHr: number;
  fargateGbHr: number;
  albHr: number;
  albLcuMonthly: number;
  rdsT4gMicroHr: number;
  rdsGp3PerGbMonth: number;
}> = {
  'us-east-1': {
    fargateVcpuHr: 0.04048,
    fargateGbHr: 0.004445,
    albHr: 0.0225,
    albLcuMonthly: 3.65,
    rdsT4gMicroHr: 0.016,
    rdsGp3PerGbMonth: 0.115,
  },
  'ap-south-1': {
    fargateVcpuHr: 0.04456,
    fargateGbHr: 0.0049,
    albHr: 0.0239,
    albLcuMonthly: 3.9,
    rdsT4gMicroHr: 0.017,
    rdsGp3PerGbMonth: 0.131,
  },
};

const FIXED_MONTHLY = {
  ecrStorage: 0.1,
  cloudwatchLogs: 0.5,
  codeBuild: 0.5,
  dataTransfer: 3.0,
};

const SECRET_MONTHLY = 0.4;
const RDS_STORAGE_GB = 20;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/* ----------------------------------------------------------- GCP / Azure -- */

export type CloudName = 'gcp' | 'azure';

export interface CloudEstimateOpts {
  archetype: 'app' | 'serverless' | 'microservices';
  /** Number of microservices (microservices archetype only). */
  services?: number;
  withDatabase?: boolean;
  withCache?: boolean;
  /** True when min instances ≥ 1 (no scale-to-zero). */
  alwaysOn?: boolean;
}

/**
 * Hand-maintained monthly prices (USD) for the GCP/Azure blueprints. Both
 * platforms bill serverless compute per-second with free tiers, so "light
 * traffic" numbers are small and the disclaimer carries the honesty.
 */
const GCP_MONTHLY = {
  runLight: 3.0,        // Cloud Run, scale-to-zero, light traffic
  runAlwaysOn: 66.0,    // 1 vCPU / 512Mi kept warm 730h
  cloudSqlMicro: 11.0,  // db-f1-micro + 10 GB
  artifactRegistry: 0.5,
  cloudBuild: 0.5,      // mostly inside the free 2,500 build-min tier
  memorystore1Gb: 37.0,
  functionsLight: 0.5,
  pubsubLight: 0.5,
  firestoreLight: 1.0,
  secret: 0.06,
};

const AZURE_MONTHLY = {
  containerAppLight: 3.0,    // consumption plan after free grants, light traffic
  containerAppAlwaysOn: 27.0, // 0.5 vCPU / 1 GiB kept warm 730h
  acrBasic: 5.0,
  logAnalytics: 2.0,
  pgFlexB1ms: 17.0,          // B1ms + 32 GB
  cosmosServerlessLight: 2.0,
  redisC0: 16.0,
  functionsLight: 0.5,
  storageAccount: 1.0,
};

const CLOUD_DISCLAIMER =
  'Estimate ±20% at light traffic, based on published on-demand prices (region can shift prices ~±10%). ' +
  'Serverless compute here bills per request/second — heavy traffic raises it, idle costs almost nothing.';

export function estimateCloud(cloud: CloudName, o: CloudEstimateOpts): Estimate {
  const lines: EstimateLine[] = [];
  const n = Math.max(1, o.services ?? 1);

  if (cloud === 'gcp') {
    if (o.archetype === 'serverless') {
      lines.push({ item: 'Cloud Functions (pay-per-request, light traffic)', monthly: GCP_MONTHLY.functionsLight });
      lines.push({ item: 'Pub/Sub queue', monthly: GCP_MONTHLY.pubsubLight });
      lines.push({ item: 'Firestore database (light usage)', monthly: GCP_MONTHLY.firestoreLight });
      lines.push({ item: 'Cloud Build + source storage', monthly: GCP_MONTHLY.cloudBuild });
    } else {
      const per = o.alwaysOn ? GCP_MONTHLY.runAlwaysOn : GCP_MONTHLY.runLight;
      lines.push({
        item: `Cloud Run ${o.archetype === 'microservices' ? `(${n} services, ` : '('}${o.alwaysOn ? 'always-on' : 'scale-to-zero, light traffic'})`,
        monthly: round2(per * n),
      });
      lines.push({ item: 'Artifact Registry (images)', monthly: GCP_MONTHLY.artifactRegistry });
      lines.push({ item: 'Image builds (Cloud Build)', monthly: GCP_MONTHLY.cloudBuild });
      if (o.withDatabase) lines.push({ item: 'Cloud SQL PostgreSQL (db-f1-micro, 10 GB)', monthly: GCP_MONTHLY.cloudSqlMicro });
      if (o.withCache) lines.push({ item: 'Memorystore Redis (1 GB basic)', monthly: GCP_MONTHLY.memorystore1Gb });
    }
  } else {
    if (o.archetype === 'serverless') {
      lines.push({ item: 'Azure Functions (consumption, light traffic)', monthly: AZURE_MONTHLY.functionsLight });
      lines.push({ item: 'Storage account (queue + table)', monthly: AZURE_MONTHLY.storageAccount });
    } else {
      const per = o.alwaysOn ? AZURE_MONTHLY.containerAppAlwaysOn : AZURE_MONTHLY.containerAppLight;
      lines.push({
        item: `Container Apps ${o.archetype === 'microservices' ? `(${n} services, ` : '('}${o.alwaysOn ? 'always-on' : 'scale-to-zero, light traffic'})`,
        monthly: round2(per * n),
      });
      lines.push({ item: 'Container Registry (Basic)', monthly: AZURE_MONTHLY.acrBasic });
      lines.push({ item: 'Log Analytics (app logs)', monthly: AZURE_MONTHLY.logAnalytics });
      if (o.withDatabase && o.archetype === 'app') lines.push({ item: 'PostgreSQL Flexible Server (B1ms, 32 GB)', monthly: AZURE_MONTHLY.pgFlexB1ms });
      if (o.withDatabase && o.archetype === 'microservices') lines.push({ item: 'Cosmos DB — MongoDB API (serverless, light)', monthly: AZURE_MONTHLY.cosmosServerlessLight });
      if (o.withCache) lines.push({ item: 'Azure Cache for Redis (Basic C0)', monthly: AZURE_MONTHLY.redisC0 });
    }
  }

  const monthly = round2(lines.reduce((s, l) => s + l.monthly, 0));
  return {
    monthly,
    daily: round2(monthly / (HOURS_PER_MONTH / 24)),
    yearly: round2(monthly * 12),
    lines,
    disclaimer: CLOUD_DISCLAIMER,
  };
}

export function estimate(p: BlueprintParams): Estimate {
  const price = PRICES[p.region];
  const lines: EstimateLine[] = [];

  const vcpu = p.cpu / 1024;
  const gb = p.memoryMb / 1024;
  const fargate =
    (vcpu * price.fargateVcpuHr + gb * price.fargateGbHr) * HOURS_PER_MONTH * p.desiredCount;
  lines.push({
    item: `App containers (${p.desiredCount} × ${vcpu} vCPU / ${gb} GB, Fargate)`,
    monthly: round2(fargate),
  });

  const alb = price.albHr * HOURS_PER_MONTH + price.albLcuMonthly;
  lines.push({ item: 'Load balancer (ALB)', monthly: round2(alb) });

  if (p.withDatabase) {
    const rds = price.rdsT4gMicroHr * HOURS_PER_MONTH + price.rdsGp3PerGbMonth * RDS_STORAGE_GB;
    lines.push({ item: 'PostgreSQL database (db.t4g.micro, 20 GB)', monthly: round2(rds) });
  }

  if (p.appSecrets.length > 0) {
    lines.push({
      item: `Secrets Manager (${p.appSecrets.length} secret${p.appSecrets.length > 1 ? 's' : ''})`,
      monthly: round2(SECRET_MONTHLY * p.appSecrets.length),
    });
  }

  lines.push({ item: 'Container registry (ECR)', monthly: FIXED_MONTHLY.ecrStorage });
  lines.push({ item: 'Logs (CloudWatch, 7-day retention)', monthly: FIXED_MONTHLY.cloudwatchLogs });
  lines.push({ item: 'Image builds (CodeBuild)', monthly: FIXED_MONTHLY.codeBuild });
  lines.push({ item: 'Data transfer (typical small app)', monthly: FIXED_MONTHLY.dataTransfer });

  const monthly = round2(lines.reduce((s, l) => s + l.monthly, 0));
  return {
    monthly,
    daily: round2(monthly / (HOURS_PER_MONTH / 24)),
    yearly: round2(monthly * 12),
    lines,
    disclaimer:
      'Estimate ±15%. Based on published AWS on-demand prices for this blueprint; actual usage (traffic, storage growth) can move the number. A budget alert is created with your stack.',
  };
}
