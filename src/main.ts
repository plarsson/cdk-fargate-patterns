import * as ec2 from '@aws-cdk/aws-ec2';
import * as ecs from '@aws-cdk/aws-ecs';
import * as elbv2 from '@aws-cdk/aws-elasticloadbalancingv2';
import * as route53 from '@aws-cdk/aws-route53';
import * as targets from '@aws-cdk/aws-route53-targets';
import * as cdk from '@aws-cdk/core';


export interface DualAlbFargateServiceProps {
  readonly vpc?: ec2.IVpc;
  readonly tasks: FargateTaskProps[];
  readonly route53Ops?: Route53Options;
  /**
   * create a FARGATE_SPOT only cluster
   * @default false
   */
  readonly spot?: boolean;
  /**
   * Whether to enable ECS Exec support
   * @see https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs-exec.html
   * @default false
   */
  readonly enableExecuteCommand?: boolean;
  /**
   * The subnets to associate with the service.
   * @default -
   * {
   *       subnetType: ec2.SubnetType.PRIVATE,
   * }
   */
  readonly vpcSubnets?: ec2.SubnetSelection;
}

export interface FargateTaskProps {
  readonly task: ecs.FargateTaskDefinition;
  readonly listenerPort: number;
  /**
   * desired number of tasks for the service
   * @default 1
   */
  readonly desiredCount?: number;
  /**
   * service autoscaling policy
   */
  readonly scalingPolicy?: ServiceScalingPolicy;
  readonly capacityProviderStrategy?: ecs.CapacityProviderStrategy[];
  /**
   * Internal only. Do not expose the service on the internet-facing load balancer.
   * @default false
   */
  readonly internalOnly?: boolean;
}

export interface ServiceScalingPolicy {
  /**
   * max capacity for the service autoscaling
   * @default 10
   */
  readonly maxCapacity?: number;
  /**
   * target cpu utilization
   * @default 50
   */
  readonly targetCpuUtilization?: number;
  /**
   * request per target
   * @default 1000
   */
  readonly requestPerTarget?: number;
}

export interface Route53Options {
  /**
   * private zone name
   * @default svc.local
   */
  readonly zoneName?: string;
  /**
   * the external ALB record name
   * @default external
   */
  readonly externalAlbRecordName?: string;
  /**
   * the internal ALB record name
   * @default internal
   */
  readonly internalAlbRecordName?: string;
}

export class DualAlbFargateService extends cdk.Construct {
  readonly externalAlb?: elbv2.ApplicationLoadBalancer
  readonly internalAlb: elbv2.ApplicationLoadBalancer
  readonly vpc: ec2.IVpc;
  /**
   * The service(s) created from the task(s)
   */
  readonly service: ecs.FargateService[];
  private hasExternalLoadBalancer: boolean = false;
  private vpcSubnets: ec2.SubnetSelection = { subnetType: ec2.SubnetType.PRIVATE };
  constructor(scope: cdk.Construct, id: string, props: DualAlbFargateServiceProps) {
    super(scope, id);

    this.vpc = props.vpc ?? getOrCreateVpc(this),
    this.service = [];
    if (props.vpcSubnets) {
      this.vpcSubnets = props.vpcSubnets;
    }

    // determine whether we need the external LB
    props.tasks.forEach(t => {
      if (!t.internalOnly) { this.hasExternalLoadBalancer = true; }
    });

    if (this.hasExternalLoadBalancer) {
      this.externalAlb = new elbv2.ApplicationLoadBalancer(this, 'ExternalAlb', {
        vpc: this.vpc,
        internetFacing: true,
      });
    }

    this.internalAlb = new elbv2.ApplicationLoadBalancer(this, 'InternalAlb', {
      vpc: this.vpc,
      internetFacing: false,
    });

    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: this.vpc,
      enableFargateCapacityProviders: true,
    });

    const spotOnlyStrategy = [
      {
        capacityProvider: 'FARGATE_SPOT',
        base: 0,
        weight: 1,
      },
      {
        capacityProvider: 'FARGATE',
        base: 0,
        weight: 0,
      },
    ];

    props.tasks.forEach(t => {
      const defaultContainerName = t.task.defaultContainer?.containerName;
      const svc = new ecs.FargateService(this, `${defaultContainerName}Service`, {
        taskDefinition: t.task,
        cluster,
        capacityProviderStrategies: t.capacityProviderStrategy ?? ( props.spot ? spotOnlyStrategy : undefined ),
        desiredCount: t.desiredCount,
        enableExecuteCommand: props.enableExecuteCommand ?? false,
        vpcSubnets: this.vpcSubnets,
        assignPublicIp: isPublicSubnet(this.vpc, this.vpcSubnets),
      });
      this.service.push(svc);

      // default scaling policy
      const scaling = svc.autoScaleTaskCount({ maxCapacity: t.scalingPolicy?.maxCapacity ?? 10 });
      scaling.scaleOnCpuUtilization('CpuScaling', {
        targetUtilizationPercent: t.scalingPolicy?.targetCpuUtilization ?? 50,
      });

      // not internalOnly
      if (!t.internalOnly) {
        const exttg = new elbv2.ApplicationTargetGroup(this, `${defaultContainerName}ExtTG`, {
          protocol: elbv2.ApplicationProtocol.HTTP,
          vpc: this.vpc,
        });
        // listener for the external ALB
        new elbv2.ApplicationListener(this, `ExtAlbListener${t.listenerPort}`, {
          loadBalancer: this.externalAlb!,
          open: true,
          port: t.listenerPort,
          protocol: elbv2.ApplicationProtocol.HTTP,
          defaultTargetGroups: [exttg],
        });
        scaling.scaleOnRequestCount('RequestScaling', {
          requestsPerTarget: t.scalingPolicy?.requestPerTarget ?? 1000,
          targetGroup: exttg,
        });
        exttg.addTarget(svc);
      }

      const inttg = new elbv2.ApplicationTargetGroup(this, `${defaultContainerName}IntTG`, {
        protocol: elbv2.ApplicationProtocol.HTTP,
        vpc: this.vpc,
      });

      // listener for the internal ALB
      new elbv2.ApplicationListener(this, `IntAlbListener${t.listenerPort}`, {
        loadBalancer: this.internalAlb,
        open: true,
        port: t.listenerPort,
        protocol: elbv2.ApplicationProtocol.HTTP,
        defaultTargetGroups: [inttg],
      });


      // extra scaling policy
      scaling.scaleOnRequestCount('RequestScaling2', {
        requestsPerTarget: t.scalingPolicy?.requestPerTarget ?? 1000,
        targetGroup: inttg,
      });

      inttg.addTarget(svc);
    });

    // Route53
    const zoneName = props.route53Ops?.zoneName ?? 'svc.local';
    const externalAlbRecordName = props.route53Ops?.externalAlbRecordName ?? 'external';
    const internalAlbRecordName = props.route53Ops?.internalAlbRecordName ?? 'internal';
    const zone = new route53.PrivateHostedZone(this, 'HostedZone', {
      zoneName,
      vpc: this.vpc,
    });

    new route53.ARecord(this, 'InternalAlbAlias', {
      zone,
      recordName: internalAlbRecordName,
      target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(this.internalAlb)),
    });

    if (this.externalAlb) {
      new route53.ARecord(this, 'ExternalAlbAlias', {
        zone,
        recordName: externalAlbRecordName,
        target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(this.externalAlb)),
      });
    }


    if (this.externalAlb) {
      new cdk.CfnOutput(this, 'ExternalEndpoint', { value: `http://${this.externalAlb.loadBalancerDnsName}` });
      new cdk.CfnOutput(this, 'ExternalEndpointPrivate', { value: `http://${externalAlbRecordName}.${zoneName}` });
    }
    new cdk.CfnOutput(this, 'InternalEndpoint', { value: `http://${this.internalAlb.loadBalancerDnsName}` });
    new cdk.CfnOutput(this, 'InternalEndpointPrivate', { value: `http://${internalAlbRecordName}.${zoneName}` });
  }
}

function getOrCreateVpc(scope: cdk.Construct): ec2.IVpc {
  // use an existing vpc or create a new one
  return scope.node.tryGetContext('use_default_vpc') === '1'
    || process.env.CDK_USE_DEFAULT_VPC === '1' ? ec2.Vpc.fromLookup(scope, 'Vpc', { isDefault: true }) :
    scope.node.tryGetContext('use_vpc_id') ?
      ec2.Vpc.fromLookup(scope, 'Vpc', { vpcId: scope.node.tryGetContext('use_vpc_id') }) :
      new ec2.Vpc(scope, 'Vpc', { maxAzs: 3, natGateways: 1 });
}

function isPublicSubnet(vpc: ec2.IVpc, vpcSubnets: ec2.SubnetSelection): boolean {
  const subnets = vpc.selectSubnets(vpcSubnets);
  // get all subnets in the VPC
  const allsubnetIds = vpc.publicSubnets.concat(vpc.privateSubnets).concat(vpc.isolatedSubnets).map(x => x.subnetId);
  // validate the given subnets
  subnets.subnetIds.forEach(s => {
    if (!allsubnetIds.includes(s)) {
      throw new Error(`${s} does not exist in the VPC`);
    }
    if (vpc.isolatedSubnets.map(i => i.subnetId).includes(s)) {
      throw new Error(`Isolated subnet ${s} is not allowed`);
    }
  });
  const hasPublic = subnets.subnetIds.some(s => new Set(vpc.publicSubnets.map(x => x.subnetId)).has(s));
  const hasPrivate = subnets.subnetIds.some(s => new Set(vpc.privateSubnets.map(x => x.subnetId)).has(s));
  if (hasPublic && hasPrivate) {
    throw new Error('You should provide either all public or all private subnets, not both.');
  } else {
    return hasPublic;
  }
}
