# Route-level rollback

Before canary, record exact frontend/API/worker revisions, method ownership,
qualification evidence, observation period and rollback-window end. Before Node
removal, revert only the affected method's server routing to its retained Node
implementation; keep additive schema compatible. Confirm cookies, authorization,
job fencing and existing media references still work. Do not reset data.

After Node removal, restore a previously qualified release as an explicit release
operation. Do not retain duplicate business implementations indefinitely. Django
remains the destination. No canary or rollback has yet been executed.
