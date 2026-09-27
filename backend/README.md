# Backend parser boundary

`app.parser.RecipeParser` is the provider-independent boundary for natural-language
recipe parsing.

## Contract

- Input must satisfy `contracts/v1/schemas/recipe.schema.json`.
- Adapter output must be a non-empty list of V1 tasks and satisfy
  `contracts/v1/schemas/task.schema.json`.
- A task whose required scheduling field is marked `missing` is rejected before
  it can enter the scheduler.
- The parser emits device **requirements**, never concrete device instances.
- `FakeParserAdapter` is deterministic and intended for tests and local
  integration. A real LLM/provider adapter can implement the same `ParserAdapter`
  protocol without changing the service boundary.


The parser-only dependency file is `backend/requirements-parser.txt`; it is kept separate while the scheduler dependency PR is under review to avoid changing the same file in parallel. The final backend environment should combine both dependency sets.
