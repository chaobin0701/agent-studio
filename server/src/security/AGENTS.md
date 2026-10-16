# Security Boundary

`security/` owns cross-cutting HTTP security behavior: request identity metadata, redaction, rate-limit policy, origin checks, and normalized error responses.

Keep database ownership in the database/admin modules and model/tool policy in their existing boundaries. Add a security helper here only when it enforces a rule across more than one HTTP surface. Do not place business authorization decisions or agent reasoning in this directory.
