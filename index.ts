import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { readFileSync, readdirSync } from "fs";
import yaml = require("js-yaml");

const project = pulumi.getProject();
const stack = pulumi.getStack();
const config = new pulumi.Config();

const provider = new k8s.Provider("k8s", {
  context: config.require("kubeconfig_context"),
  namespace: project,
});

const namespace = new k8s.core.v1.Namespace(
  "namespace",
  { metadata: { name: project } },
  { provider: provider }
);

const stackgresChart = new k8s.helm.v3.Release(
  project,
  {
    namespace: namespace.metadata.name,
    chart: "stackgres-operator",
    version: "1.1.0",
    repositoryOpts: {
      repo: "https://stackgres.io/downloads/stackgres-k8s/stackgres/helm/",
    },
    values: {
      authentication: {
        user: "admin",
        password: config.requireSecret("stackgres_password"),
      },
    },
  },
  { provider: provider, dependsOn: namespace }
);

const user = pulumi.interpolate`CREATE USER ${config.require(
  "initial_database_user"
)} WITH PASSWORD '${config.requireSecret("initial_database_password")}';`;

const createUserSecretKey = "create-user.sql";

const stackgresSqlsSecret = new k8s.core.v1.Secret(
  "stackgres-sqls-secret",
  {
    stringData: {
      "create-user.sql": user,
    },
  },
  { provider: provider, dependsOn: namespace }
);

const stackgresInstanceProfile = new k8s.apiextensions.CustomResource(
  "stackgres-instance-profile",
  {
    metadata: {
      name: "4c8g",
    },
    apiVersion: "stackgres.io/v1",
    kind: "SGInstanceProfile",
    spec: {
      cpu: "4",
      memory: "8Gi",
    },
  },
  { provider: provider, dependsOn: stackgresChart }
);

const stackgresCluster = new k8s.apiextensions.CustomResource(
  "stackgres-cluster",
  {
    apiVersion: "stackgres.io/v1",
    kind: "SGCluster",
    spec: {
      instances: 3,
      postgres: {
        version: "14",
        extensions: [{ name: "fuzzystrmatch" }],
      },
      sgInstanceProfile: stackgresInstanceProfile.metadata.name,
      prometheusAutobind: true,
      pods: {
        persistentVolume: {
          size: "100Gi",
        },
      },
      initialData: {
        scripts: [
          {
            name: "create-stackgres-user",
            scriptFrom: {
              secretKeyRef: {
                name: stackgresSqlsSecret.metadata.name,
                key: "create-user.sql",
              },
            },
          },
          {
            name: "create-stackgres-database",
            script: `CREATE DATABASE ${config.require(
              "initial_database_name"
            )} WITH OWNER ${config.require("initial_database_user")};`,
          },
        ],
      },
    },
  },
  { provider: provider, dependsOn: stackgresChart }
);

const postgresServiceLabels = {
  app: "StackGresCluster",
  cluster: "true",
  "cluster-name": "stackgres-cluster-8dawtfo8",
  role: "master",
};

const postgresService = new k8s.core.v1.Service(
  "postgres-service",
  {
    metadata: {
      labels: postgresServiceLabels,
    },
    spec: {
      type: "NodePort",
      ports: [{ port: 5432, name: "pgport", targetPort: "pgport" }],
      selector: postgresServiceLabels,
    },
  },
  { provider: provider }
);

const postgresScrape = new k8s.apiextensions.CustomResource(
  "postgres-scrape",
  {
    apiVersion: "operator.victoriametrics.com/v1beta1",
    kind: "VMServiceScrape",
    spec: {
      endpoints: [
        {
          port: "prometheus-postgres-exporter",
        },
      ],
      namespaceSelector: {
        matchNames: [project],
      },
      selector: {
        matchLabels: {
          app: "StackGresCluster",
          "cluster-name": "stackgres-cluster-8dawtfo8",
          "cluster-namespace": "stackgres",
          "cluster-uid": "dc8a0f05-a935-4600-b380-e70a34bcfb04",
        },
      },
    },
  },
  { provider: provider }
);

const envoyScrape = new k8s.apiextensions.CustomResource(
  "envoy-scrape",
  {
    apiVersion: "operator.victoriametrics.com/v1beta1",
    kind: "VMServiceScrape",
    spec: {
      endpoints: [
        {
          path: "/stats/prometheus",
          port: "envoy",
        },
      ],
      namespaceSelector: {
        matchNames: [project],
      },
      selector: {
        matchLabels: {
          app: "StackGresCluster",
          "cluster-name": "stackgres-cluster-8dawtfo8",
          "cluster-namespace": "stackgres",
          "cluster-uid": "dc8a0f05-a935-4600-b380-e70a34bcfb04",
        },
      },
    },
  },
  { provider: provider }
);

const postgresAlerts = new k8s.apiextensions.CustomResource(
  "postgres-alerts",
  {
    apiVersion: "operator.victoriametrics.com/v1beta1",
    kind: "VMRule",
    spec: yaml.load(readFileSync("alerts.yaml", "utf-8")),
  },
  { provider: provider, dependsOn: stackgresChart }
);
