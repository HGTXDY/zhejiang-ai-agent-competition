"""Reviewable prompt templates for the model-driven planning conversation."""
from __future__ import annotations

from functools import lru_cache
from importlib.resources import files
from string import Template

PROMPT_PACKAGE = "app.agent_prompts"


@lru_cache(maxsize=None)
def load_prompt(name: str) -> str:
    return files(PROMPT_PACKAGE).joinpath(name).read_text(encoding="utf-8")


def render_prompt(name: str, **context: object) -> str:
    return Template(load_prompt(name)).safe_substitute({key: str(value) for key, value in context.items()})
