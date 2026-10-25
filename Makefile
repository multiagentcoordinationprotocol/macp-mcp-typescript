# The cross-language contract is owned by the Python macp-mcp: contract/tools.json
# (generated from its FastMCP server) and contract/gate/ (the `macp-mcp gate`
# policy schema, CLI, wire values and context_id vectors). This repo vendors
# both verbatim, so drift between the two servers is a byte-level diff.
CONTRACT_REPO ?= multiagentcoordinationprotocol/macp-mcp
CONTRACT_REF  ?= main
CONTRACT_BASE := https://raw.githubusercontent.com/$(CONTRACT_REPO)/$(CONTRACT_REF)
CONTRACT_FILES := contract/tools.json \
	contract/gate/gate.schema.json \
	contract/gate/example.gate.json \
	contract/gate/context-id-vectors.json \
	contract/gate/cli.json \
	contract/gate/session.json

.PHONY: verify-contract sync-contract

verify-contract: ## Fail if any contract file drifted from the Python macp-mcp's
	@tmp=$$(mktemp); trap 'rm -f $$tmp' EXIT; status=0; \
	for f in $(CONTRACT_FILES); do \
	  curl -fsSL --retry 3 "$(CONTRACT_BASE)/$$f" -o $$tmp || { echo "cannot fetch $(CONTRACT_BASE)/$$f"; status=1; continue; }; \
	  if cmp -s $$tmp $$f; then echo "$$f matches $(CONTRACT_REPO)@$(CONTRACT_REF)"; \
	  else echo "$$f drifted from $(CONTRACT_REPO)@$(CONTRACT_REF); run 'make sync-contract'"; diff -u $$tmp $$f | head -40; status=1; fi; \
	done; exit $$status

sync-contract: ## Refresh every contract file from the Python macp-mcp
	@for f in $(CONTRACT_FILES); do mkdir -p $$(dirname $$f); curl -fsSL --retry 3 "$(CONTRACT_BASE)/$$f" -o $$f || exit 1; echo "synced $$f"; done
