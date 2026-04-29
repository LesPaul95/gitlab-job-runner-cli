#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const dotenv = require("dotenv");

dotenv.config();

const API_BASE = process.env.GITLAB_API_BASE || "https://gitlab.com/api/v4";
const TOKEN = process.env.GITLAB_TOKEN;
const DEFAULT_BRANCH = process.env.DEFAULT_BRANCH || "stable";
const PROJECTS_FILE = process.env.PROJECTS_FILE || "projects.json";
const PROJECT_LINKS = loadProjectsFromFile(PROJECTS_FILE);

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));

  if (command === "help" || options.help) {
    printHelp();
    process.exit(0);
  }

  if (command !== "deploy") {
    console.error(`Unknown command: ${command || "<empty>"}`);
    printHelp();
    process.exit(1);
  }

  if (!TOKEN) {
    throw new Error("GITLAB_TOKEN is not set in .env");
  }

  if (!PROJECT_LINKS.length) {
    throw new Error(`No projects found in ${PROJECTS_FILE}`);
  }

  const requestedBranch = options.branch;
  if (!requestedBranch) {
    throw new Error("Pass branch name: --branch Feature-1");
  }

  const jobName = options.job || "to_dev1";
  const projectFilter = options.project;

  const selectedProjects = projectFilter
    ? PROJECT_LINKS.filter((item) => item.name === projectFilter)
    : PROJECT_LINKS;

  if (!selectedProjects.length) {
    throw new Error(
      `No projects found for --project ${projectFilter}. Check ${PROJECTS_FILE}`,
    );
  }

  for (const project of selectedProjects) {
    await deployProject({
      project,
      requestedBranch,
      defaultBranch: DEFAULT_BRANCH,
      jobName,
    });
  }
}

async function deployProject({
  project,
  requestedBranch,
  defaultBranch,
  jobName,
}) {
  const projectPath = normalizeProjectPath(project.projectPath);
  const encodedProject = encodeURIComponent(projectPath);

  console.log(`\n=== ${project.name} (${projectPath}) ===`);

  const branchExists = await doesBranchExist(encodedProject, requestedBranch);
  const targetBranch = branchExists ? requestedBranch : defaultBranch;

  if (!branchExists) {
    console.log(
      `Branch "${requestedBranch}" not found. Fallback to "${defaultBranch}".`,
    );
  } else {
    console.log(`Branch "${requestedBranch}" found.`);
  }

  const targetSha = await getBranchHeadSha(encodedProject, targetBranch);
  const lastDeployedSha = await getLastSuccessfulJobCommitSha(
    encodedProject,
    jobName,
  );

  if (lastDeployedSha && lastDeployedSha === targetSha) {
    console.log(
      `Skip deploy: latest successful "${jobName}" already deployed commit ${targetSha}.`,
    );
    return;
  }

  if (lastDeployedSha) {
    console.log(
      `New deploy needed: target SHA ${targetSha}, last deployed SHA ${lastDeployedSha}.`,
    );
  } else {
    console.log(
      `No successful "${jobName}" deployments found. Deploying target SHA ${targetSha}.`,
    );
  }

  const { pipelineId, targetJob } = await findPlayableJobInExistingPipelines(
    encodedProject,
    targetBranch,
    jobName,
  );
  console.log(
    `Using existing pipeline: ${pipelineId} (branch: ${targetBranch})`,
  );

  if (targetJob.status !== "manual") {
    console.log(
      `Job "${jobName}" status is "${targetJob.status}". Trying to play anyway...`,
    );
  }

  const playedJob = await playJob(encodedProject, targetJob.id);
  console.log(`Triggered job "${jobName}" (job id: ${playedJob.id})`);

  const pipelineStatus = await waitForPipelineCompletion(
    encodedProject,
    pipelineId,
  );
  console.log(`Пайплайн ${pipelineId} завершен. Статус: ${pipelineStatus}`);

  if (pipelineStatus !== "success") {
    throw new Error(
      `Pipeline ${pipelineId} finished with status "${pipelineStatus}"`,
    );
  }
}

async function doesBranchExist(encodedProject, branchName) {
  const encodedBranch = encodeURIComponent(branchName);
  const response = await gitlabFetch(
    `/projects/${encodedProject}/repository/branches/${encodedBranch}`,
    { throwOnNotFound: false },
  );
  return response.status === 200;
}

async function getBranchHeadSha(encodedProject, branchName) {
  const response = await gitlabFetch(
    `/projects/${encodedProject}/repository/branches/${encodeURIComponent(
      branchName,
    )}`,
  );
  const branch = await response.json();
  return branch?.commit?.id;
}

async function getLastSuccessfulJobCommitSha(encodedProject, jobName) {
  const response = await gitlabFetch(
    `/projects/${encodedProject}/jobs?scope[]=success&order_by=updated_at&sort=desc&per_page=100`,
  );
  const jobs = await response.json();

  if (!Array.isArray(jobs)) {
    return null;
  }

  const lastJob = jobs.find((job) => job.name === jobName);
  return lastJob?.commit?.id || null;
}

async function waitForJobs(encodedProject, pipelineId) {
  const maxAttempts = 15;
  const delayMs = 2000;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await gitlabFetch(
      `/projects/${encodedProject}/pipelines/${pipelineId}/jobs`,
    );
    const jobs = await response.json();

    if (Array.isArray(jobs) && jobs.length > 0) {
      return jobs;
    }

    await sleep(delayMs);
  }

  throw new Error(`No jobs found in pipeline ${pipelineId} after waiting.`);
}

async function findPlayableJobInExistingPipelines(
  encodedProject,
  branchName,
  jobName,
) {
  const pipelines = await getRecentPipelinesByRef(encodedProject, branchName);
  if (!pipelines.length) {
    throw new Error(
      `No existing pipelines found for branch "${branchName}". Run pipeline in GitLab first.`,
    );
  }

  for (const pipeline of pipelines) {
    const jobs = await waitForJobs(encodedProject, pipeline.id);
    const targetJob = jobs.find((job) => job.name === jobName);
    if (targetJob) {
      return { pipelineId: pipeline.id, targetJob };
    }
  }

  throw new Error(
    `Job "${jobName}" not found in recent pipelines for branch "${branchName}".`,
  );
}

async function getRecentPipelinesByRef(encodedProject, branchName) {
  const response = await gitlabFetch(
    `/projects/${encodedProject}/pipelines?ref=${encodeURIComponent(
      branchName,
    )}&order_by=updated_at&sort=desc&per_page=20`,
  );
  const pipelines = await response.json();
  return Array.isArray(pipelines) ? pipelines : [];
}

async function playJob(encodedProject, jobId) {
  const response = await gitlabFetch(
    `/projects/${encodedProject}/jobs/${jobId}/play`,
    { method: "POST" },
  );
  return response.json();
}

async function waitForPipelineCompletion(encodedProject, pipelineId) {
  const finalStatuses = new Set([
    "success",
    "failed",
    "canceled",
    "skipped",
    "manual",
  ]);
  const delayMs = 5000;

  while (true) {
    const response = await gitlabFetch(
      `/projects/${encodedProject}/pipelines/${pipelineId}`,
    );
    const pipeline = await response.json();

    if (finalStatuses.has(pipeline.status)) {
      return pipeline.status;
    }

    console.log(`Pipeline ${pipelineId} status: ${pipeline.status}... waiting`);
    await sleep(delayMs);
  }
}

async function gitlabFetch(path, options = {}) {
  const { throwOnNotFound = true, ...fetchOptions } = options;
  const url = `${API_BASE}${path}`;

  const response = await fetch(url, {
    ...fetchOptions,
    headers: {
      "PRIVATE-TOKEN": TOKEN,
      "Content-Type": "application/json",
      ...(fetchOptions.headers || {}),
    },
  });

  if (!response.ok) {
    if (!throwOnNotFound && response.status === 404) {
      return response;
    }

    const message = await safeReadErrorBody(response);
    throw new Error(
      `GitLab API error ${response.status} for ${path}: ${message}`,
    );
  }

  return response;
}

async function safeReadErrorBody(response) {
  try {
    return await response.text();
  } catch (error) {
    return "Unable to read error body";
  }
}

function loadProjectsFromFile(fileName) {
  const filePath = path.resolve(process.cwd(), fileName);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Projects file not found: ${filePath}`);
  }

  const raw = fs.readFileSync(filePath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${fileName} must be valid JSON array`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`${fileName} must contain a JSON array`);
  }

  for (const item of parsed) {
    if (!item.name || !item.projectPath) {
      throw new Error(
        `Each project in ${fileName} must contain { name, projectPath }`,
      );
    }
  }

  return parsed;
}

function normalizeProjectPath(value) {
  if (!value.includes("://")) {
    return value;
  }

  const parsed = new URL(value);
  return parsed.pathname.replace(/^\/+/, "");
}

function parseArgs(args) {
  const [first] = args;
  const command = !first || first.startsWith("-") ? "help" : first;

  const options = {};
  const startIndex = command === "help" ? 0 : 1;
  for (let i = startIndex; i < args.length; i += 1) {
    const current = args[i];
    const next = args[i + 1];

    if (current === "--help" || current === "-h") {
      options.help = true;
      continue;
    }

    if (current.startsWith("--")) {
      const key = current.slice(2);
      options[key] = next;
      i += 1;
    }
  }

  return { command, options };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printHelp() {
  console.log(`
Usage:
  gitlab-deploy deploy --branch Feature-1 [--job to_dev1] [--project app1]

Options:
  --branch   Source branch to deploy
  --job      Manual job name in GitLab pipeline (default: to_dev1)
  --project  Deploy only one project by name from projects.json
  --help     Show this help
  `);
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
