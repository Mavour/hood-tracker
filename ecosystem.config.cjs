/** PM2 ecosystem — Next.js app + optional BullMQ worker */
module.exports = {
  apps: [
    {
      name: "hood-tracker",
      script: "node_modules/next/dist/bin/next",
      args: "start -H 127.0.0.1",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        PORT: "8080",
        NEXT_BASE_PATH: "/hood",
        NEXT_PUBLIC_BASE_PATH: "/hood",
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
