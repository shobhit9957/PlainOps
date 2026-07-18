# 🛍️ ShopFlow — a 7-microservice store (MongoDB)

A fully-fledged, scalable e-commerce backend split into 7 independent microservices,
each with its own database schema, all persisting to MongoDB.

## The 7 services

| Service | Port | Responsibility | Data (MongoDB) |
|---|---|---|---|
| **gateway** | 8080 | Single entry point. Reverse-proxies `/api/<service>/*` to each service and serves the storefront UI. | — |
| **users** | 3001 | Accounts & profiles. | `users` |
| **products** | 3002 | Product catalog (seeds itself). | `products` |
| **cart** | 3003 | Per-user shopping cart. | `carts` |
| **orders** | 3004 | Places orders; calls **payments** then **notifications** (service-to-service). | `orders` |
| **payments** | 3005 | Charges an order (simulated). Stateless. | — |
| **notifications** | 3006 | Sends order notifications. Stateless. | — |

```
                         ┌──────────► users     (MongoDB: users)
   Browser ──► gateway ──┼──────────► products  (MongoDB: products)
                         ├──────────► cart      (MongoDB: carts)
                         └──────────► orders  ──┬─► payments  (charge)
                                    (orders)    └─► notifications
```

## Run it locally (needs Docker)

```bash
docker compose up --build
# open http://localhost:8080  →  browse products, add to cart, checkout
```

MongoDB runs as the `mongo` service; each microservice reads `MONGODB_URI` from its
environment. Every service exposes `/health`.

## Deploying to AWS with PLAINOPS

Each service is already container-ready (its own Dockerfile). Deploying all 7 as a
scalable production system needs PLAINOPS's **multi-service blueprint** (a shared
load balancer with path-based routing, one autoscaling ECS service per microservice,
and **Amazon DocumentDB** as the managed MongoDB) — that capability is the next build.
See the project chat for status.

## Scaling to 100k+ users

- Each service scales **independently** (add replicas to the hot ones — usually products & gateway).
- MongoDB → **DocumentDB** (or MongoDB Atlas) with read replicas.
- Stateless services (gateway, payments, notifications) scale horizontally with no shared state.
- Cart/session data is per-user and shardable by `userId`.
