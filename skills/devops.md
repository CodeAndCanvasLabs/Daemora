---
name: devops
description: Docker, deployment, CI/CD, server management, infrastructure
triggers: docker, dockerfile, compose, deploy, deployment, ci, cd, github actions, pipeline, nginx, kubernetes, k8s, terraform, ansible, infrastructure, build, release, staging, production
---
## Docker
- `Dockerfile`: minimize layers, use multi-stage builds, pin versions, don't run as root
- `docker-compose.yml`: define services, volumes, networks. Use .env for config.
- Debug: `docker logs <container>`, `docker exec -it <container> sh`
- Cleanup: `docker system prune -f` (careful in production)

## CI/CD (GitHub Actions)
- Workflow structure: trigger → jobs → steps
- Cache dependencies (`actions/cache`) to speed up builds
- Run tests before deploy. Fail fast.
- Use secrets for API keys - never hardcode
- Pin action versions (`actions/checkout@v4`, not `@main`)

## Deployment Checklist
1. Tests pass locally
2. Environment variables set in target
3. Database migrations run
4. Health check endpoint works
5. Rollback plan ready
6. Monitoring/alerting configured

## Server Management
- Logs: `journalctl -u service -f`, `tail -f /var/log/app.log`
- Process: `systemctl status/start/stop/restart service`
- Resources: `htop`, `df -h`, `free -m`
- Network: `ss -tlnp` (listening ports), `curl -I localhost:port`

## Don't
- Don't deploy without testing
- Don't store secrets in Dockerfiles or git
- Don't use `latest` tag in production
- Don't skip health checks
