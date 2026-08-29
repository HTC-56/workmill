# deploy/ — systemd units and install guide

Install every `.service` and `.timer` file into `/etc/systemd/system/` on the
target host, then reload the daemon:

```
sudo cp deploy/*.service deploy/*.timer /etc/systemd/system/
sudo systemctl daemon-reload
```

## Install order

1. Build the project: `pnpm build`
2. Copy `dist/`, `package.json`, and `node_modules/` to `/opt/workmill`.
3. Write `/etc/workmill/workmill.yaml` from `deploy/workmill.example.yaml` and
   edit it for your gateway, models, and worker id.
4. Write `/etc/workmill/workmill.env` with the two secrets
   (`WORKMILL_OPERATOR_TOKEN`, `GATEWAY_API_KEY`) and set mode `0600`:

   ```
   sudo install -m 0600 -o root -g root /dev/stdin \
     /etc/workmill/workmill.env
   ```

5. Enable and start the gateway unit (replace `workmill-gateway` if your real
   gateway uses a different name), then start workmill:

   ```
   sudo systemctl enable --now workmill-gateway.service
   sudo systemctl enable --now workmill.service
   ```

6. (Optional) Enable the hourly demo-reset timer:

   ```
   sudo systemctl enable --now workmill-reset.timer
   ```

## Deployment is a human decision

**The demo can be deployed publicly today because the repo ships scripts to
seed, expose, and reset it — but the operator must make every choice.**  The
following items are **human-gated** and must be decided before workmill touches
real traffic, per DECISIONS.md:

| Decision | Where it lands |
|---|---|
| Host / cloud provider | chosen by operator |
| Tunnel or reverse proxy | chosen by operator |
| Public URL | chosen by operator |
| Demo reset cadence | `OnCalendar=` in `workmill-reset.timer` |

The repo ships the tools; a human runs them and owns the consequences.
