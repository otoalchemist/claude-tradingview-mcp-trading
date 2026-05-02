// PM2 process manager config for Craig Accumulation Bot v2
// Usage:
//   pm2 start ecosystem.config.cjs        # start (paper trading)
//   pm2 restart craig-accum-bot           # restart
//   pm2 stop    craig-accum-bot           # stop
//   pm2 logs    craig-accum-bot           # stream logs
//   pm2 save                              # persist across reboots
//   pm2 startup                           # enable auto-start on server reboot
//
// To switch to live trading without editing .env:
//   LIVE_TRADING=true pm2 restart craig-accum-bot --update-env

module.exports = {
  apps: [
    {
      name: "craig-accum-bot",
      script: "craig-accumulation-bot.mjs",
      interpreter: "node",
      interpreter_args: "--experimental-vm-modules",

      // Auto-restart on crash, but not if it exits cleanly (exit code 0)
      autorestart: true,
      watch: false,
      max_restarts: 10,
      min_uptime: "30s",         // must stay up 30s to count as a successful start
      restart_delay: 5000,       // wait 5s between crash restarts

      // Environment — paper trading by default.
      // Copy .env.example → .env and fill in real values.
      env: {
        NODE_ENV: "production",
        LIVE_TRADING: "false",   // flip to "true" for real money
      },

      // Log files
      out_file: "./logs/craig-accum-bot.out.log",
      error_file: "./logs/craig-accum-bot.err.log",
      merge_logs: false,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      max_size: "50M",           // rotate at 50 MB (requires pm2-logrotate)
    },
  ],
};
