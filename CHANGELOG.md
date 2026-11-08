# Changelog

## [0.4.0](https://github.com/multiagentcoordinationprotocol/macp-mcp-typescript/compare/v0.3.0...v0.4.0) (2026-11-08)


### Bug Fixes

* **docs:** document the Quorum gate threshold when a stricter policy is bound ([#11](https://github.com/multiagentcoordinationprotocol/macp-mcp-typescript/issues/11)) ([2ffcf7e](https://github.com/multiagentcoordinationprotocol/macp-mcp-typescript/commit/2ffcf7ebf97541aa9b2dfd28f2e344476acae198))
* **gate:** cancel the approval session on any refusal after SessionStart; a commit refused with a code other than POLICY_DENIED or SESSION_NOT_OPEN used to leave it OPEN until its TTL ([#10](https://github.com/multiagentcoordinationprotocol/macp-mcp-typescript/issues/10)) ([2ffcf7e](https://github.com/multiagentcoordinationprotocol/macp-mcp-typescript/commit/2ffcf7ebf97541aa9b2dfd28f2e344476acae198))

### Dependencies

* require macp-sdk-typescript ^0.23.1 (0.3.0 required ^0.17.1) ([#8](https://github.com/multiagentcoordinationprotocol/macp-mcp-typescript/issues/8)) ([2ffcf7e](https://github.com/multiagentcoordinationprotocol/macp-mcp-typescript/commit/2ffcf7ebf97541aa9b2dfd28f2e344476acae198))
* test against macp-runtime 0.14.0, including a policy-refused gate commit ([#9](https://github.com/multiagentcoordinationprotocol/macp-mcp-typescript/issues/9), [#10](https://github.com/multiagentcoordinationprotocol/macp-mcp-typescript/issues/10)) ([2ffcf7e](https://github.com/multiagentcoordinationprotocol/macp-mcp-typescript/commit/2ffcf7ebf97541aa9b2dfd28f2e344476acae198))

## [0.3.0](https://github.com/multiagentcoordinationprotocol/macp-mcp-typescript/compare/v0.2.0...v0.3.0) (2026-10-25)


### Features

* **gate:** macp-mcp gate — quorum-gated upstream tool calls (W3.8) ([#5](https://github.com/multiagentcoordinationprotocol/macp-mcp-typescript/issues/5)) ([503f5f4](https://github.com/multiagentcoordinationprotocol/macp-mcp-typescript/commit/503f5f413ee77de1d95d9e7802f647313d6e1df7))

## [0.2.0](https://github.com/multiagentcoordinationprotocol/macp-mcp-typescript/compare/v0.1.0...v0.2.0) (2026-10-25)


### Features

* macp-mcp TypeScript twin, an MCP server for MACP Decision sessions ([#1](https://github.com/multiagentcoordinationprotocol/macp-mcp-typescript/issues/1)) ([39310ca](https://github.com/multiagentcoordinationprotocol/macp-mcp-typescript/commit/39310ca8b6056af95fdde5d0dc33edbad9da5aee))

## Changelog

All notable changes to this project are documented here. Releases are cut by
release-please from Conventional Commits.
