# Trusted proxy configuration

The API ignores `X-Forwarded-*` headers unless `TRUST_PROXY_ADDRESSES` explicitly lists trusted proxy IP addresses or CIDRs. An empty value is the safe default. Do not use `*`, a hop count, or a broad public range to make forwarded client identity appear to work.

## Staging and production operator TODO

- [ ] Obtain the exact immediate proxy egress/source address ranges from the hosting or network operator for this deployment environment.
- [ ] Confirm whether the request reaches the API through one proxy or multiple hops, and identify which hop sets or sanitizes `X-Forwarded-For`.
- [ ] Set `TRUST_PROXY_ADDRESSES` to only the verified proxy IPs/CIDRs, comma-separated. Do not guess Railway or Cloudflare ranges; verify the actual path and current provider documentation with the operator.
- [ ] Deploy to staging and verify client IP/rate-limit behavior through the real ingress, including that a client-supplied forwarding header cannot override the ingress value.
- [ ] Record the source and review date for the ranges; repeat verification when ingress/network configuration changes.

Until these steps are complete, leave the value empty. Forwarded client IP identity and IP-based rate-limit partitioning will then use the direct peer address.
