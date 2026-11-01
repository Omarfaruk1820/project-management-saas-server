const db = await connectToMongoDB();

const userId = req.user.firebaseUid;

const projects = await db
  .collection("projects")
  .find({ ownerId: userId })
  .toArray();

const projectIds = projects.map((project) => project._id);

const tasks = await db
  .collection("tasks")
  .find({ projectId: { $in: projectIds } })
  .toArray();

const now = new Date();

const stats = {
  totalProjects: projects.length,

  activeProjects: projects.filter((project) => project.status === "active")
    .length,

  totalTasks: tasks.length,

  openTasks: tasks.filter((task) =>
    ["todo", "in-progress", "review"].includes(task.status),
  ).length,

  completedTasks: tasks.filter((task) => task.status === "done").length,

  overdueTasks: tasks.filter(
    (task) =>
      task.dueDate && new Date(task.dueDate) < now && task.status !== "done",
  ).length,
};

return res.json({
  success: true,
  data: {
    stats,
    recentProjects: projects
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
      .slice(0, 5),
  },
});
