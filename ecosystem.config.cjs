/** PM2 ecosystem — Next.js app + optional BullMQ worker */
module.exports = {
  apps: [
    {
      name: "hood-tracker",
      script: "node_modules/next/dist/bin/next",
      args: "start -p 3000",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "hood-tracker-worker",
      script: "npx",
      args: "tsx worker/index.ts",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
