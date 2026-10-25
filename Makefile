# The tool contract (contract/tools.json) is owned by the Python macp-mcp,
# which generates it from its FastMCP server. This server serves it verbatim,
# so drift between the two is a byte-level diff of one file.
CONTRACT_REPO ?= multiagentcoordinationprotocol/macp-mcp
CONTRACT_REF  ?= main
CONTRACT_URL  := https://raw.githubusercontent.com/$(CONTRACT_REPO)/$(CONTRACT_REF)/contract/tools.json

.PHONY: verify-contract sync-contract

verify-contract: ## Fail if contract/tools.json drifted from the Python macp-mcp's
	@tmp=$$(mktemp); trap 'rm -f $$tmp' EXIT; \
	curl -fsSL --retry 3 "$(CONTRACT_URL)" -o $$tmp || { echo "cannot fetch $(CONTRACT_URL)"; exit 1; }; \
	if cmp -s $$tmp contract/tools.json; then echo "contract/tools.json matches $(CONTRACT_REPO)@$(CONTRACT_REF)"; \
	else echo "contract/tools.json drifted from $(CONTRACT_REPO)@$(CONTRACT_REF); run 'make sync-contract'"; diff -u $$tmp contract/tools.json | head -40; exit 1; fi

sync-contract: ## Refresh contract/tools.json from the Python macp-mcp
	curl -fsSL --retry 3 "$(CONTRACT_URL)" -o contract/tools.json
