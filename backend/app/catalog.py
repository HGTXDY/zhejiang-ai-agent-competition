"""Official recipe catalog for `GET /recipes` and the parse loop.

Reads the immutable official CSV (`data/official/recipes_100.csv`) and exposes
V1-shaped recipe summaries and full parseable payloads. Step splitting is
delegated to `scripts.build_annotation_template.split_steps` so the catalog and
the batch parse pipeline always agree on step text, and ingredient de-duplication
matches the recipe schema's `uniqueItems` requirement.
"""
from __future__ import annotations

import csv
from functools import lru_cache
from pathlib import Path
from typing import Any

from scripts.build_annotation_template import split_steps

ROOT = Path(__file__).resolve().parents[2]
RECIPES_CSV = ROOT / "data" / "official" / "recipes_100.csv"


def _dedupe_ingredients(raw: str) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for part in raw.split("；"):
        item = part.strip()
        if item and item not in seen:
            seen.add(item)
            result.append(item)
    return result


@lru_cache(maxsize=1)
def _load_recipes() -> tuple[dict[str, Any], ...]:
    with RECIPES_CSV.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    recipes = []
    for row in rows:
        recipes.append(
            {
                "recipe_id": row["菜谱id"].strip(),
                "name": row["名称"].strip(),
                "ingredients": _dedupe_ingredients(row.get("食材清单", "")),
                "steps_text": split_steps(row.get("烹饪步骤", "")),
            }
        )
    return tuple(recipes)


def list_recipe_summaries(limit: int | None = None, q: str | None = None) -> dict[str, Any]:
    recipes = _load_recipes()
    if q:
        needle = q.strip()
        recipes = tuple(recipe for recipe in recipes if needle in recipe["name"])
    if limit is not None:
        recipes = recipes[:limit]
    summaries = [
        {
            "recipe_id": recipe["recipe_id"],
            "name": recipe["name"],
            "ingredient_count": len(recipe["ingredients"]),
            "step_count": len(recipe["steps_text"]),
        }
        for recipe in recipes
    ]
    return {"schema_version": "1.0", "total": len(summaries), "recipes": summaries}


def get_recipe_payload(recipe_id: str) -> dict[str, Any] | None:
    for recipe in _load_recipes():
        if recipe["recipe_id"] == recipe_id:
            return {
                "schema_version": "1.0",
                "recipe_id": recipe["recipe_id"],
                "name": recipe["name"],
                "ingredients": recipe["ingredients"],
                "steps_text": recipe["steps_text"],
                "source": "official",
            }
    return None
