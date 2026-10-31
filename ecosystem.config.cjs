// pm2 process file: `pm2 start ecosystem.config.cjs` keeps the bot running and restarts it on crash/reboot.
module.exports = {
  apps: [
    {
      name: "near-trade-bot",
      script: "dist/index.js",
      node_args: "--enable-source-maps",
      max_restarts: 50,
      restart_delay: 2000,
      env: { NODE_ENV: "production" },
    },
  ],
};
