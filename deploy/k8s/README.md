# Kubernetes 部署

本目录提供 Skill Market 服务的 K8s 部署清单。

## 文件

| 文件 | 作用 |
|---|---|
| `configmap.yaml` | 非敏感配置（端口、TOS endpoint/bucket/region/prefix、PUBLIC_BASE_URL 等） |
| `secret.example.yaml` | 敏感配置**模板**（DB 连接串、TOS 密钥）。**勿提交填好真值的版本** |
| `deployment.yaml` | Deployment（含 initContainer 建表 + 健康探针 + 资源限制） |
| `service.yaml` | ClusterIP Service（仅集群内暴露） |

## 前置条件

1. 已构建并推送镜像到镜像仓库，替换 `deployment.yaml` 里两处 `image: skill-market:latest`。
2. Postgres 已就绪，且**集群 Pod 能内网访问**（库未开公网时，服务须与库同 VPC/网络）。
3. 运维已用 `migrations/001_skill_market.sql` + `dist-archives/skill_market_seed.sql` 建表并导入 499 行数据。
   - 注：Deployment 的 initContainer 只做幂等建表（保险），**数据导入仍需运维单独执行**。
4. 火山 TOS 桶 `nanobee-dev` 已上传归档至 `skill-market-mcp/skills/{skill_id}/skill.tar.gz`。

## 部署步骤

```bash
# 1. 准备 Secret（复制模板，填真实值）
cp secret.example.yaml secret.yaml
#   编辑 secret.yaml，填 DATABASE_URL / TOS_ACCESS_KEY / TOS_SECRET_KEY

# 2. 按顺序 apply
kubectl apply -f configmap.yaml
kubectl apply -f secret.yaml
kubectl apply -f deployment.yaml
kubectl apply -f service.yaml

# 3. 观察滚动发布
kubectl rollout status deployment/skill-market

# 4. 自检（集群内）
kubectl run curl --rm -it --image=curlimages/curl --restart=Never -- \
  curl -s http://skill-market:4000/v1/skills
#   应返回 {"count":499,...}
```

## 注意

- **安全**：本服务 v1 无鉴权，Service 用 ClusterIP 仅内网暴露，仅供 nanoctl 访问。**不要**改成 LoadBalancer/NodePort 暴露公网。
- **PUBLIC_BASE_URL**：`configmap.yaml` 里需改成详情接口 `archive_url` 应使用的真实可达地址。
- **readOnlyRootFilesystem**：已开启。若要启用查询日志（`SKILL_MARKET_QUERY_LOG`）写盘，需额外挂载可写 volume。
