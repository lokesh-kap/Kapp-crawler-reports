module.exports = {
  apps: [
    {
      name: "kapp-crawler",
      script: "dist/main.js",

      exec_mode: "cluster",
      instances: 2,

      node_args: "--max-old-space-size=1536",
      max_memory_restart: "1400M",

      autorestart: true,
      watch: false,

      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
