# Split Groups PR 5: Hook Group Surfaces Into Flagged Path

This branch is reserved for wiring terminal, editor, and browser surfaces into
the split-group ownership path while the feature flag remains off by default.

Scope:
- remove duplicate legacy ownership under the flagged path
- route group-local surface creation and restore through the new model
- preserve existing default behavior while the flag stays off

