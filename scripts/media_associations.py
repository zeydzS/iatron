"""Conservative picture attachments derived from original Visio layout.

Never rewrite source text or infer clinical connections. Uncertain positions
retain their previous attachment and are recorded for visual review.
"""
from __future__ import annotations

import math
import re
from collections import Counter

ROUTER = re.compile(r"[A-Z0-9]{1,3}")
MAX_GAP = 0.2
MIN_MARGIN = 0.15


def valid_geometry(geometry: dict) -> bool:
    return all(isinstance(geometry.get(key), (int, float)) and math.isfinite(geometry[key])
               for key in ("x", "y", "width", "height")) and geometry["width"] > 0 and geometry["height"] > 0


def rectangle_gap(first: dict, second: dict) -> float:
    dx = max(0, abs(first["x"] - second["x"]) - (first["width"] + second["width"]) / 2)
    dy = max(0, abs(first["y"] - second["y"]) - (first["height"] + second["height"]) / 2)
    return math.hypot(dx, dy)


def reassociate_media(flow: dict, scheme: dict) -> list[dict]:
    """Mutate only media lists; preserve every image placement and every text."""
    by_shape: dict[str, list[dict]] = {}
    for shape in scheme["nodes"]:
        by_shape.setdefault(str(shape["original_shape_id"]), []).append(shape)
    placements = [media for page in flow["pages"] for node in page["nodes"] for media in node.get("media", [])]
    before = Counter((str(media.get("source_shape_id")), media.get("sha256")) for media in placements)
    reviews = []
    for page in flow["pages"]:
        nodes = page["nodes"]
        connected = {node.get("next") for node in nodes}
        connected.update(option.get("go_to") for node in nodes for option in (node.get("input") or {}).get("options", []))
        candidates = []
        for node in nodes:
            matching = by_shape.get(str(node["id"]), [])
            if len(matching) != 1:
                continue
            source = matching[0]
            if (node["id"] in connected or node.get("next") or node.get("input")) and node.get("text", "").strip() and not ROUTER.fullmatch(node["text"].strip()):
                if not source.get("parent_node_id") and not source["geometry"].get("rotation") and valid_geometry(source["geometry"]):
                    candidates.append((node, source))
        pending = [(node, media) for node in nodes for media in node.get("media", [])]
        for node in nodes:
            node["media"] = []
        for previous, media in pending:
            image_shapes = by_shape.get(str(media.get("source_shape_id")), [])
            chosen = previous
            status = "review_required"
            ranked = []
            reason = "missing_or_ambiguous_source_shape"
            image = image_shapes[0] if len(image_shapes) == 1 else None
            if image and not image.get("parent_node_id") and not image["geometry"].get("rotation") and valid_geometry(image["geometry"]):
                ranked = sorted(((rectangle_gap(image["geometry"], source["geometry"]), node, source)
                                 for node, source in candidates if source["page_id"] == image["page_id"]),
                                key=lambda item: (item[0], str(item[1]["id"])))
                if ranked:
                    distance, target, target_source = ranked[0]
                    margin = ranked[1][0] - distance if len(ranked) > 1 else math.inf
                    if distance <= MAX_GAP and margin >= MIN_MARGIN:
                        chosen = target
                        status = "repaired" if chosen["id"] != previous["id"] else "confirmed_layout"
                        reason = "unique_adjacent_connected_text"
                        media["association"] = "source-layout-adjacent-instruction"
                    else:
                        reason = "distant_or_competing_instruction_boxes"
                else:
                    reason = "no_connected_text_with_page_geometry"
            elif image:
                reason = "group_transform_or_geometry_requires_review"
            media["review_required"] = True
            chosen["media"].append(media)
            reviews.append({
                "procedure_id": flow["document_id"],
                "source_image_shape_id": media.get("source_shape_id"),
                "source_sha256": media.get("sha256"),
                "source_relative_path": scheme["document"]["relative_path"],
                "image_geometry": image.get("geometry") if image else None,
                "previous_text_shape_id": previous["id"],
                "previous_text": previous.get("text", ""),
                "attached_text_shape_id": chosen["id"],
                "attached_text": chosen.get("text", ""),
                "status": status,
                "reason": reason,
                "candidates": [{"text_shape_id": node["id"], "text": node.get("text", ""), "rectangle_gap": round(distance, 6)}
                               for distance, node, _ in ranked[:3]],
            })
    after = Counter((str(media.get("source_shape_id")), media.get("sha256")) for page in flow["pages"] for node in page["nodes"] for media in node.get("media", []))
    if after != before:
        raise ValueError("Picture association changed the source placement inventory")
    return reviews
