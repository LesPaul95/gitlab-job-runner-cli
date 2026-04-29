import chalk from "chalk";

export async function runLastDeployCommand({
  projects,
  projectFilter,
  jobName,
  normalizeProjectPath,
  gitlabFetch,
}) {
  const selectedProjects = projectFilter
    ? projects.filter((item) => item.name === projectFilter)
    : projects;

  if (!selectedProjects.length) {
    throw new Error(`No projects found for --project ${projectFilter}.`);
  }

  const results = await Promise.all(
    selectedProjects.map(async (project) => {
      const projectPath = normalizeProjectPath(project.projectPath);
      const encodedProject = encodeURIComponent(projectPath);
      const response = await gitlabFetch(
        `/projects/${encodedProject}/jobs?scope[]=success&order_by=updated_at&sort=desc&per_page=100`,
      );
      const jobs = await response.json();
      const latestJob = Array.isArray(jobs)
        ? jobs.find((job) => job.name === jobName)
        : null;

      return {
        projectName: project.name,
        latestJob,
      };
    }),
  );

  for (const item of results) {
    if (!item.latestJob) {
      console.log(
        `${chalk.red.bold(item.projectName)} - job "${jobName}" не была успешно выполнена`,
      );
      continue;
    }

    const ref = item.latestJob.ref || "-";
    const commit = item.latestJob.commit?.id || "-";
    const finishedAt =
      item.latestJob.finished_at || item.latestJob.updated_at || "-";
    const formattedTime = formatDateTime(finishedAt);

    console.log(
      `${chalk.blue.bold(item.projectName)} - ветка: ${ref}, коммит: ${commit.slice(0, 8)}, выполнена: ${formattedTime}`,
    );
  }
}

function formatDateTime(value) {
  if (!value || value === "-") {
    return "-";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = String(date.getFullYear());
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");

  return `${hours}:${minutes}:${seconds} ${day}/${month}/${year}`;
}
