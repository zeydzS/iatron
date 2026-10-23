from __future__ import annotations

import hashlib
import html
import json
import shutil
import sys
import uuid
import zipfile
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from media_associations import reassociate_media


APP_ROOT = Path(__file__).resolve().parents[1]
PROJECT_ROOT = APP_ROOT.parent
CORPUS_ROOT = PROJECT_ROOT / "first_aid_converted"
SOURCE_SITE_DATA = PROJECT_ROOT.parent / "IazamedProject" / "website" / "public" / "data"
OUTPUT_ROOT = APP_ROOT / "generated"
FLOW_OUTPUT = OUTPUT_ROOT / "flows"
PUBLIC_OUTPUT = OUTPUT_ROOT / "public" / "data"
DEVELOPMENT_OUTPUT = OUTPUT_ROOT / "development"
REPORT_OUTPUT = OUTPUT_ROOT / "build-report.json"
NAMESPACE = uuid.UUID("c025779c-74bf-4e53-b4e5-1fd4345f1ed8")


def compact(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def geometry_distance(old_node: dict, new_node: dict) -> float:
    old_geometry = old_node.get("source", {}).get("geometry", {})
    new_geometry = new_node.get("geometry", {})
    return sum(
        abs(float(old_geometry.get(key) or 0) - float(new_geometry.get(key) or 0))
        for key in ("x", "y", "width", "height")
    )


def map_nodes(flow: dict, scheme: dict) -> dict[str, str]:
    by_shape: dict[str, list[dict]] = defaultdict(list)
    for node in scheme["nodes"]:
        by_shape[str(node.get("original_shape_id"))].append(node)

    mapping: dict[str, str] = {}
    used: set[str] = set()
    for old_node in flow["pages"][0]["nodes"]:
        shape_id = str(old_node.get("source", {}).get("shape_id", old_node["id"]))
        candidates = by_shape.get(shape_id, [])
        ranked = sorted(
            candidates,
            key=lambda candidate: (
                candidate["node_id"] in used,
                candidate.get("text", "") != old_node.get("text", ""),
                geometry_distance(old_node, candidate),
                candidate["node_id"],
            ),
        )
        if not ranked:
            raise ValueError(f"No current node matches shape {shape_id} in {flow['document_id']}")
        chosen = ranked[0]["node_id"]
        mapping[str(old_node["id"])] = chosen
        used.add(chosen)
    return mapping


def remap_media(media: list[dict], assets_by_source: dict[str, dict]) -> list[dict]:
    result = []
    for item in media:
        mapped = assets_by_source.get(item.get("sha256", ""))
        if not mapped:
            raise ValueError(f"No canonical redesigned asset for source SHA {item.get('sha256')}")
        canonical_id = mapped["canonical_id"]
        result.append(
            {
                "asset_id": canonical_id,
                "url": f"/media/{canonical_id}.png",
                "content_type": "image/png",
                "association": item.get("association", "source-mapped"),
                "source_image_shape_id": item.get("source_shape_id"),
                "rights_status": "uncertain",
                "review_required": True,
            }
        )
    return result


def branch_candidate_rank(choice_node: dict, candidate: dict) -> tuple[int, int, float, str]:
    question = choice_node.get("source", {}).get("geometry", {})
    route = candidate.get("source", {}).get("geometry", {})
    qx = float(question.get("x") or 0)
    qy = float(question.get("y") or 0)
    qwidth = float(question.get("width") or 0)
    rx = float(route.get("x") or 0)
    ry = float(route.get("y") or 0)
    downstream = ry < qy
    within_width = abs(rx - qx) <= max(qwidth / 2, 0.25)
    distance = abs(ry - qy) * 2 + abs(rx - qx)
    return (0 if downstream else 1, 0 if within_width else 1, distance, str(candidate["id"]))


def resolve_branch_routes(flow: dict) -> tuple[dict[tuple[str, str], str], list[dict]]:
    nodes = [node for page in flow["pages"] for node in page["nodes"]]
    routes: dict[tuple[str, str], str] = {}
    reviews: list[dict] = []
    for choice in (node for node in nodes if node.get("input")):
        options = choice["input"].get("options", [])
        codes = sorted(
            {
                str(code).strip()
                for option in options
                for code in option.get("result_codes", [])
                if str(code).strip()
            }
        )
        resolution_by_code: dict[str, str] = {}
        for code in codes:
            candidates = [
                node
                for node in nodes
                if str(node.get("text") or "").strip() == code and node.get("next")
            ]
            if not candidates:
                reviews.append(
                    {
                        "procedure_id": flow["document_id"],
                        "choice_source_shape_id": choice.get("source", {}).get("shape_id"),
                        "result_code": code,
                        "status": "unresolved_no_source_router",
                    }
                )
                continue
            ranked = sorted(candidates, key=lambda candidate: branch_candidate_rank(choice, candidate))
            chosen = ranked[0]
            resolution_by_code[code] = str(chosen["next"])
            reviews.append(
                {
                    "procedure_id": flow["document_id"],
                    "choice_source_shape_id": choice.get("source", {}).get("shape_id"),
                    "result_code": code,
                    "status": "resolved",
                    "method": "only_source_router" if len(candidates) == 1 else "decision_local_geometry",
                    "candidate_count": len(candidates),
                    "selected_router_source_shape_id": chosen.get("source", {}).get("shape_id"),
                }
            )
        for option in options:
            targets = {
                resolution_by_code[str(code).strip()]
                for code in option.get("result_codes", [])
                if str(code).strip() in resolution_by_code
            }
            if len(targets) == 1:
                routes[(str(choice["id"]), str(option["id"]))] = targets.pop()
            elif len(targets) > 1:
                reviews.append(
                    {
                        "procedure_id": flow["document_id"],
                        "choice_source_shape_id": choice.get("source", {}).get("shape_id"),
                        "option_id": option["id"],
                        "status": "unresolved_multiple_source_destinations",
                    }
                )
    return routes, reviews


def represented_source_shape_ids(flow: dict) -> set[str]:
    represented: set[str] = set()
    for page in flow["pages"]:
        for node in page["nodes"]:
            source = node.get("source", {})
            if source.get("shape_id") is not None:
                represented.add(str(source["shape_id"]))
            input_data = node.get("input") or {}
            input_source = input_data.get("source") or {}
            if input_source.get("source_group_shape_id") is not None:
                represented.add(str(input_source["source_group_shape_id"]))
            for option in input_data.get("options", []):
                option_source = option.get("source") or {}
                for key in ("label_shape_id", "option_shape_id"):
                    if option_source.get(key) is not None:
                        represented.add(str(option_source[key]))
                represented.update(str(value) for value in option_source.get("result_code_shape_ids", []))
    return represented


def represented_source_texts(flow: dict) -> set[str]:
    represented: set[str] = set()
    for page in flow["pages"]:
        for node in page["nodes"]:
            if str(node.get("text") or "").strip():
                represented.add(str(node["text"]).strip())
            input_data = node.get("input") or {}
            if str(input_data.get("prompt") or "").strip():
                represented.add(str(input_data["prompt"]).strip())
            for option in input_data.get("options", []):
                if str(option.get("label") or "").strip():
                    represented.add(str(option["label"]).strip())
                represented.update(str(code).strip() for code in option.get("result_codes", []) if str(code).strip())
    return represented


def transform_flow(
    flow: dict, scheme: dict, assets_by_source: dict[str, dict]
) -> tuple[dict, dict[str, str], list[dict]]:
    node_mapping = map_nodes(flow, scheme)
    route_mapping, route_reviews = resolve_branch_routes(flow)
    transformed = json.loads(json.dumps(flow))
    transformed["schema_version"] = "iatron-local-flow-v2"
    transformed["document_id"] = scheme["document"]["document_id"]
    transformed["source"] = {
        "relative_path": scheme["document"]["relative_path"],
        "sha256": scheme["document"]["sha256"],
        "parser_version": scheme["document"]["parser_version"],
    }
    transformed["publication_status"] = "awaiting_medical_review"
    transformed["rights_status"] = "uncertain"

    for page in transformed["pages"]:
        page["entry_node_id"] = node_mapping.get(str(page.get("entry_node_id")))
        page["entry_node_ids"] = [
            node_mapping[str(node_id)] for node_id in page.get("entry_node_ids", []) if str(node_id) in node_mapping
        ]
        for node in page["nodes"]:
            old_id = str(node["id"])
            node["id"] = node_mapping[old_id]
            node["next"] = node_mapping.get(str(node.get("next"))) if node.get("next") else None
            node["media"] = remap_media(node.get("media", []), assets_by_source)
            node["source"] = {
                "original_shape_id": node.get("source", {}).get("shape_id"),
                "canonical_node_id": node["id"],
            }
            input_data = node.get("input")
            if input_data:
                if input_data.get("selection_mode") == "multiple":
                    codes = {str(code).strip() for option in input_data.get("options", []) for code in option.get("result_codes", [])}
                    combined = {}
                    for router in flow["pages"][0]["nodes"]:
                        code = str(router.get("text") or "").strip()
                        if len(code) > 1 and len(set(code)) == len(code) and set(code) <= codes and router.get("next"):
                            combined.setdefault(code, []).append(router)
                    input_data["combination_routes"] = {}
                    for code, candidates in combined.items():
                        # Require one explicit router: competing branches need source review.
                        if len(candidates) != 1:
                            continue
                        target = node_mapping.get(str(candidates[0]["next"]))
                        if target:
                            input_data["combination_routes"]["".join(sorted(code))] = target
                for option in input_data.get("options", []):
                    target = route_mapping.get((old_id, str(option["id"])))
                    option["go_to"] = node_mapping.get(target) if target else None

    all_ids = {node["id"] for page in transformed["pages"] for node in page["nodes"]}
    for page in transformed["pages"]:
        if page.get("entry_node_id") not in all_ids:
            raise ValueError(f"Missing entry node in {flow['document_id']}")
        for node in page["nodes"]:
            references = [node.get("next")]
            references.extend(option.get("go_to") for option in (node.get("input") or {}).get("options", []))
            references.extend((node.get("input") or {}).get("combination_routes", {}).values())
            for reference in references:
                if reference and reference not in all_ids:
                    raise ValueError(f"Broken reference {reference} in {flow['document_id']}")
    return transformed, node_mapping, route_reviews


def main() -> None:
    required = [
        CORPUS_ROOT / "first_aid_converted.zip",
        CORPUS_ROOT / "redesigned_asset_mapping.json",
        SOURCE_SITE_DATA / "catalog.json",
        SOURCE_SITE_DATA / "flows",
    ]
    missing = [str(path) for path in required if not path.exists()]
    if missing:
        raise FileNotFoundError("Missing inputs: " + ", ".join(missing))

    if OUTPUT_ROOT.exists():
        shutil.rmtree(OUTPUT_ROOT)
    FLOW_OUTPUT.mkdir(parents=True)
    PUBLIC_OUTPUT.mkdir(parents=True)
    DEVELOPMENT_OUTPUT.mkdir(parents=True)

    mapping_data = json.loads((CORPUS_ROOT / "redesigned_asset_mapping.json").read_text(encoding="utf-8"))
    assets = mapping_data["items"]
    assets_by_source = {item["source_sha256"]: item for item in assets}
    if len(assets) != 97 or len(assets_by_source) != 97:
        raise ValueError("Expected exactly 97 unique canonical assets")

    current_by_sha: dict[str, dict] = {}
    with zipfile.ZipFile(CORPUS_ROOT / "first_aid_converted.zip") as archive:
        for name in archive.namelist():
            if not name.endswith("/scheme.json"):
                continue
            scheme = json.loads(archive.read(name))
            current_by_sha[scheme["document"]["sha256"]] = scheme

    transformed_flows: list[dict] = []
    id_maps: dict[str, dict[str, str]] = {}
    source_hashes: set[str] = set()
    route_reviews: list[dict] = []
    completeness: list[dict] = []
    media_association_reviews: list[dict] = []
    for path in sorted((SOURCE_SITE_DATA / "flows").glob("*.json")):
        flow = json.loads(path.read_text(encoding="utf-8"))
        source_sha = flow["source"]["sha256"]
        scheme = current_by_sha.get(source_sha)
        if not scheme:
            raise ValueError(f"Flow {path.name} does not match the current corpus")
        media_association_reviews.extend(reassociate_media(flow, scheme))
        transformed, node_mapping, flow_route_reviews = transform_flow(flow, scheme, assets_by_source)
        procedure_id = flow["document_id"]
        transformed_flows.append(transformed)
        id_maps[procedure_id] = node_mapping
        route_reviews.extend(flow_route_reviews)
        source_hashes.add(source_sha)
        (FLOW_OUTPUT / path.name).write_text(compact(transformed), encoding="utf-8")
        represented = represented_source_shape_ids(flow)
        represented_texts = represented_source_texts(flow)
        semantic_nodes = [
            node
            for node in scheme["nodes"]
            if str(node.get("text") or "").strip() and node.get("node_type") != "decoration"
        ]
        missing = [
            {
                "source_shape_id": node.get("original_shape_id"),
                "node_type": node.get("node_type"),
                "text": node.get("text"),
            }
            for node in semantic_nodes
            if str(node.get("original_shape_id")) not in represented
            and str(node.get("text") or "").strip() not in represented_texts
        ]
        completeness.append(
            {
                "procedure_id": procedure_id,
                "source_relative_path": scheme["document"]["relative_path"],
                "source_semantic_node_count": len(semantic_nodes),
                "represented_semantic_node_count": len(semantic_nodes) - len(missing),
                "missing_semantic_nodes": missing,
                "source_connector_count": len(scheme.get("edges", [])),
                "source_image_placement_count": len(scheme.get("assets", [])),
                "guided_image_placement_count": sum(
                    len(node.get("media", [])) for page in transformed["pages"] for node in page["nodes"]
                ),
            }
        )

    catalog = json.loads((SOURCE_SITE_DATA / "catalog.json").read_text(encoding="utf-8"))
    catalog["schema_version"] = "iatron-local-catalog-v2"
    catalog["publication_status"] = "private_staging_review_only"
    for procedure_id, record in catalog["procedures"].items():
        record["path"] = f"/flows/{procedure_id}.json"
        record["publication_status"] = "awaiting_medical_review"
    for items in catalog["age_groups"].values():
        for item in items:
            raw_entry = item.get("entry_node_id")
            if raw_entry is not None:
                item["entry_node_id"] = id_maps[item["procedure_id"]].get(str(raw_entry))
            item["review_required"] = True
    (PUBLIC_OUTPUT / "catalog.json").write_text(compact(catalog), encoding="utf-8")

    rights_manifest = {
        "policy": "private staging review only; publication blocked until verified",
        "items": [
            {
                "asset_id": item["canonical_id"],
                "file": Path(item["new_canonical_path"]).name,
                "sha256": item["redesigned_sha256"],
                "rights_status": "uncertain",
                "review_status": "pending",
            }
            for item in assets
        ],
    }
    (PUBLIC_OUTPUT / "rights-manifest.json").write_text(compact(rights_manifest), encoding="utf-8")
    (DEVELOPMENT_OUTPUT / "route-review.json").write_text(
        json.dumps({"items": route_reviews}, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (DEVELOPMENT_OUTPUT / "source-completeness.json").write_text(
        json.dumps({"procedures": completeness}, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    association_counts = {
        status: sum(item["status"] == status for item in media_association_reviews)
        for status in ("repaired", "confirmed_layout", "review_required")
    }
    (DEVELOPMENT_OUTPUT / "media-association-review.json").write_text(
        json.dumps({"summary": association_counts, "items": media_association_reviews}, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    review_lines = ["# Original Visio picture and text associations", "",
                   "Source text and clinical connectors are unchanged. Layout repairs use a unique adjacent connected text box, not its center. Ambiguous placements retain their prior attachment.", "",
                   *(f"- {status}: {count}" for status, count in association_counts.items()), "",
                   "Full before/after text and three candidate boxes per image are in `media-association-review.json`.", "",
                   "## Placements needing visual review", ""]
    for item in media_association_reviews:
        if item["status"] != "review_required":
            continue
        review_lines.extend([f"### {item['procedure_id']} / image shape {item['source_image_shape_id']}", "",
                             f"Reason: {item['reason']}", "", "Current attached text:", "",
                             item["attached_text"].strip(), ""])
    (DEVELOPMENT_OUTPUT / "media-association-review.md").write_text("\n".join(review_lines), encoding="utf-8")
    cards = []
    ordered_reviews = sorted(media_association_reviews, key=lambda item: (item["status"] != "review_required", item["procedure_id"], str(item["source_image_shape_id"])))
    for item in ordered_reviews:
        asset = assets_by_source[item["source_sha256"]]
        image_path = "../../../first_aid_converted/canonical_assets/" + asset["canonical_id"] + ".png"
        original_image_path = "../../../first_aid_converted/canonical_assets_pre_style_backup/" + Path(asset["old_canonical_path"]).name
        suggestions = "".join(f"<li>Shape {html.escape(str(candidate['text_shape_id']))}: {html.escape(candidate['text'])} (box gap {candidate['rectangle_gap']})</li>" for candidate in item["candidates"])
        cards.append(
            f"<article data-status='{item['status']}'><h2>{html.escape(item['procedure_id'])} / picture {html.escape(str(item['source_image_shape_id']))}</h2>"
            f"<p><strong>{item['status']}</strong> ? {html.escape(item['reason'])}</p><p class='source'>{html.escape(item['source_relative_path'])}</p>"
            f"<div class='pictures'><figure><img loading='lazy' src='{original_image_path}' alt='Original Visio picture'><figcaption>Original Visio picture</figcaption></figure>"
            f"<figure><img loading='lazy' src='{image_path}' alt='Current illustration'><figcaption>Current illustration</figcaption></figure></div>"
            f"<div class='texts'><section><h3>Previous attachment ? shape {html.escape(str(item['previous_text_shape_id']))}</h3><pre>{html.escape(item['previous_text'])}</pre></section>"
            f"<section><h3>Current attachment ? shape {html.escape(str(item['attached_text_shape_id']))}</h3><pre>{html.escape(item['attached_text'])}</pre></section></div>"
            f"<details><summary>Other nearby instruction boxes</summary><ol>{suggestions}</ol></details></article>"
        )
    review_html = """<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Iatron ? Visio attachment review</title>
<style>body{font:16px/1.5 system-ui,sans-serif;background:#f5f7f8;color:#18292c;margin:0;padding:24px}main{max-width:1100px;margin:auto}article{background:white;border:1px solid #c8d4d7;border-radius:12px;padding:20px;margin:20px 0}h2{font-size:18px;overflow-wrap:anywhere}h3{font-size:16px}img{width:220px;max-width:100%;height:170px;object-fit:contain}.pictures{display:flex;flex-wrap:wrap;gap:24px}figure{margin:0}figcaption{font-size:13px}.texts{display:grid;grid-template-columns:1fr 1fr;gap:24px}pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}.source{font-size:13px;overflow-wrap:anywhere}select{padding:10px;font:inherit}[hidden]{display:none}@media(max-width:650px){.texts{grid-template-columns:1fr}body{padding:12px}}</style>
<main><h1>Visio picture and text review</h1><p>All original text remains intact. Clear picture attachments were repaired from the original text-box boundaries. Ambiguous placements retain their previous attachment. Original Visio pictures are shown beside the current canonical replacements.</p>
""" + f"<p>{association_counts['repaired']} repaired ? {association_counts['confirmed_layout']} confirmed ? {association_counts['review_required']} require review</p>" + """
<label for="status">Show placements:</label> <select id="status"><option value="review_required">Require review</option><option value="repaired">Repaired</option><option value="confirmed_layout">Confirmed layout</option><option value="all">All</option></select>
""" + "".join(cards) + """</main><script>const select=document.getElementById('status');function filter(){for(const card of document.querySelectorAll('article'))card.hidden=select.value!=='all'&&card.dataset.status!==select.value;}select.addEventListener('change',filter);filter();</script></html>"""
    (DEVELOPMENT_OUTPUT / "media-association-review.html").write_text(review_html, encoding="utf-8")

    report = {
        "flow_count": len(transformed_flows),
        "current_source_hash_count": len(source_hashes),
        "canonical_asset_count": len(assets),
        "media_association_repaired_count": association_counts["repaired"],
        "media_association_review_required_count": association_counts["review_required"],
        "catalog_procedure_count": len(catalog["procedures"]),
        "menu_choice_count": sum(len(items) for items in catalog["age_groups"].values()),
        "source_semantic_node_count": sum(item["source_semantic_node_count"] for item in completeness),
        "represented_semantic_node_count": sum(item["represented_semantic_node_count"] for item in completeness),
        "missing_semantic_node_count": sum(len(item["missing_semantic_nodes"]) for item in completeness),
        "source_connector_count": sum(item["source_connector_count"] for item in completeness),
        "source_image_placement_count": sum(item["source_image_placement_count"] for item in completeness),
        "guided_image_placement_count": sum(item["guided_image_placement_count"] for item in completeness),
        "resolved_branch_code_count": sum(item["status"] == "resolved" for item in route_reviews),
        "unresolved_branch_code_count": sum(item["status"].startswith("unresolved") for item in route_reviews),
        "all_flows_matched_current_corpus": len(source_hashes) == len(transformed_flows),
        "all_assets_rights_review_required": True,
        "patient_data_included": False,
    }
    REPORT_OUTPUT.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
