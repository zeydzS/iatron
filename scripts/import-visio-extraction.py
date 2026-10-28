"""Build offline app content from the audited fresh Visio extraction.

The compatibility template supplies navigation IDs and UI presentation only.
Text, table labels, codes and image placement evidence come from the fresh
source graphs. Every retained next-step link is checked against source glue.
"""
from __future__ import annotations

from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import sys

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
EXTRACTION = ROOT / "first_aid_reextracted"
OUTPUT = EXTRACTION / "runtime"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":"))+"\n", encoding="utf-8")


def build_procedure_catalog(documents, flows):
    """List each original age-folder diagram once, using its filename title.

    Menu diagrams contain symptom aliases (for example Headache -> Concussion).
    Those remain inside their original flows, not as extra procedure files.
    """
    ages = ("infant", "child", "adolescent", "adult")
    catalog = {
        "schema_version": "iatron-procedure-catalog-v3",
        "entry_policy": "one-original-procedure-file-per-age",
        "age_groups": {age: [] for age in ages},
        "procedures": {},
    }
    by_document = {flow["document_id"]: (key, flow) for key, flow in flows.items()}
    assert len(by_document) == len(flows), "Duplicate original document"
    for doc in documents.values():
        age = doc["section"]
        if age not in catalog["age_groups"]:
            continue
        key, flow = by_document[doc["id"]]
        assert flow["age_group"] == age
        assert flow["source"]["relative_path"] == doc["source"]["relative_path"]
        assert flow["source"]["sha256"] == doc["source"]["sha256"]
        title, removed = re.subn(
            r"\s+[-\u2013\u2014]\s+" + age + r"\s+(?:FA|AF)$", "",
            Path(doc["source"]["relative_path"]).stem, flags=re.IGNORECASE,
        )
        assert removed == 1, (doc["title"], "unrecognized procedure filename")
        procedure_id = Path(key).stem
        nodes = {node["id"]: node for page in flow["pages"] for node in page["nodes"]}
        entry = flow["pages"][0]["entry_node_id"]
        # Prefer a source root bearing the actual procedure name when it exists.
        # Otherwise retain the already validated diagram entry, not a new route.
        roots = {node_id for page in flow["pages"] for node_id in page["entry_node_ids"]}
        named_roots = [node for node in nodes.values()
                       if node["id"] in roots and (node.get("next") or node.get("input"))
                       and node["text"].split("\n")[0].strip().casefold() == title.casefold()]
        if len(named_roots) == 1:
            entry = named_roots[0]["id"]
        assert entry in nodes, (title, "missing source entry")
        assert procedure_id not in catalog["procedures"], procedure_id
        source = {**doc["source"], "document_id": doc["id"],
                  "entry_shape_id": nodes[entry]["source"]["original_shape_id"]}
        catalog["procedures"][procedure_id] = {
            "document_id": procedure_id, "title": title, "age_group": age,
            "is_menu": False, "path": key, "source": source,
        }
        catalog["age_groups"][age].append({
            "id": procedure_id, "label": title, "procedure_id": procedure_id,
            "entry_node_id": entry, "source": source,
        })
    for age, items in catalog["age_groups"].items():
        items.sort(key=lambda item: (item["label"].casefold(), item["id"]))
        assert len(items) == sum(doc["section"] == age for doc in documents.values())
    assert sum(map(len, catalog["age_groups"].values())) == len(catalog["procedures"])
    return catalog


def run():
    index = read(EXTRACTION / "index.json")
    audit = read(EXTRACTION / "audit.json")
    validation = read(EXTRACTION / "saved_export_validation.json")
    assert audit["counts"]["audit_issues"] == 0 and validation["issue_count"] == 0
    index_sha = sha((EXTRACTION / "index.json").read_bytes())
    library = read(ROOT / "website/content/navigation-template.json")
    documents = {d["id"]: d for d in (read(EXTRACTION/e["file_path"]) for e in index["documents"])}
    assert len(documents) == len(library["flows"]) == index["counts"]["documents"]
    media_catalog = {}
    for original in index["image_catalog"]:
        source = EXTRACTION / original["asset_path"]
        assert sha(source.read_bytes()) == original["sha256"]
        asset_id = "img-" + original["sha256"][:16]
        destination = OUTPUT / "media" / (asset_id + ".png")
        destination.parent.mkdir(parents=True, exist_ok=True)
        with Image.open(source) as image:
            rgba = image.convert("RGBA")
            pixel_sha = sha(rgba.tobytes())
            rgba.save(destination, format="PNG", optimize=True)
        with Image.open(destination) as bundled:
            assert sha(bundled.convert("RGBA").tobytes()) == pixel_sha
        media_catalog[original["sha256"]] = {
            "asset_id": asset_id, "url": "/media/" + asset_id + ".png",
            "source_asset_path": original["asset_path"], "source_sha256": original["sha256"],
            "bundled_sha256": sha(destination.read_bytes()), "decoded_rgba_sha256": pixel_sha,
        }
    assert len({m["asset_id"] for m in media_catalog.values()}) == len(media_catalog)
    counts = Counter()
    flow_metadata = []
    for key, flow in library["flows"].items():
        doc = documents[flow["document_id"]]
        raw = read(EXTRACTION / doc["source_graph"]["file_path"])
        assert flow["source"]["sha256"] == raw["document"]["sha256"] == doc["source"]["sha256"]
        original = ROOT / "first_aid_visio_original" / doc["source"]["relative_path"]
        assert sha(original.read_bytes()) == doc["source"]["sha256"]
        source_nodes = {n["node_id"]: n for n in raw["nodes"]}
        by_shape = {n["original_shape_id"]: n for n in raw["nodes"] if n["text"].strip()}
        source_edges = {e["original_connector_id"]: e for e in raw["edges"]}
        pairs = {(e["source_node_id"], e["target_node_id"]) for e in raw["edges"] if e["resolution_status"] == "resolved" and e["direction"] == "directed"}
        nodes = {n["id"]: n for p in flow["pages"] for n in p["nodes"]}
        for n in nodes.values():
            source = source_nodes[n["id"]]
            n["text"] = source["text"]
            n["media"] = []
            if n.get("next"):
                assert (n["id"], n["next"]) in pairs, (doc["title"], source["original_shape_id"], "next is not a source connector")
                counts["verified_next_links"] += 1
            inp = n.get("input")
            if not inp:
                continue
            # Group prompt is a child text shape, not the empty group envelope.
            if not n["text"].strip():
                group = next((sn for pg in doc["pages"] for sn in pg["nodes"] if sn["id"] == n["id"]), None)
                assert group and group["source_table_rows"], (doc["title"], "missing source table")
                first_row = group["source_table_rows"][0]["cells"]
                assert len(first_row) == 1
                n["text"] = first_row[0]["text"]
            inp["prompt"] = n["text"]
            for opt in inp["options"]:
                src = opt["source"]
                label_id = src.get("label_shape_id") or src.get("option_shape_id")
                if label_id:
                    opt["label"] = by_shape[str(label_id)]["text"]
                else:
                    edge = source_edges[str(src["connector_shape_id"])]
                    assert edge["source_node_id"] == n["id"]
                    opt["label"] = source_nodes[edge["target_node_id"]]["text"]
                if src.get("result_code_shape_ids"):
                    codes = [by_shape[str(sid)]["text"].strip() for sid in src["result_code_shape_ids"]]
                    assert codes == opt.get("result_codes", [])
                    opt["result_codes"] = codes
                if opt.get("go_to"):
                    codes = opt.get("result_codes", [])
                    if codes:
                        for code in codes:
                            assert any(sn["text"].strip() == code and (sn["node_id"], opt["go_to"]) in pairs for sn in raw["nodes"])
                    else:
                        assert (n["id"], opt["go_to"]) in pairs
                    counts["verified_option_routes"] += 1
                counts["fresh_option_labels"] += 1
            for code, target in inp.get("combination_routes", {}).items():
                assert any(sn["text"].strip() == code and (sn["node_id"], target) in pairs for sn in raw["nodes"])
                counts["verified_combination_routes"] += 1
        flow["unassigned_media"] = []
        for pg in doc["pages"]:
            for placement in pg["image_placements"]:
                image = media_catalog[placement["image"]["sha256"]]
                media = {"asset_id": image["asset_id"], "url": image["url"],
                         "placement_id": placement["asset_id"], "content_type": "image/png",
                         "source_image_shape_id": placement["source_image_shape_id"],
                         "source_sha256": image["source_sha256"], "association_status": placement["status"],
                         "review_required": True}
                target = placement["target_node_id"]
                if target and target in nodes:
                    nodes[target]["media"].append(media)
                    counts["inferred_assigned_images"] += 1
                else:
                    media["association_status"] = "needs_review"
                    media["candidate_source_shape_ids"] = [c["source_shape_id"] for c in placement["candidates"]]
                    flow["unassigned_media"].append(media)
                    counts["unassigned_images"] += 1
        flow["schema_version"] = "iatron-fresh-visio-flow-v1"
        flow["source"]["extraction_index_sha256"] = index_sha
        flow["source"]["extraction_schema_version"] = index["schema_version"]
        flow["source_content"] = {"pages": [{"source_page_id": p["source_page_id"],
            "nodes": [{k: n[k] for k in ("id", "source_shape_id", "text", "parent_source_node_id", "source_table_rows")} for n in p["nodes"]],
            "connectors": p["connectors"]} for p in doc["pages"]]}
        counts["source_text_fields"] += sum(bool(n["text"].strip()) for p in flow["source_content"]["pages"] for n in p["nodes"])
        counts["source_connectors"] += sum(len(p["connectors"]) for p in flow["source_content"]["pages"])
        counts["source_tables"] += sum(bool(n["source_table_rows"]) for p in flow["source_content"]["pages"] for n in p["nodes"])
        write(OUTPUT / key.lstrip("/"), flow)
        flow_metadata.append({"document_id": flow["document_id"], "source_sha256": flow["source"]["sha256"], "path": key})
    library["catalog"] = build_procedure_catalog(documents, library["flows"])
    counts["catalog_procedures"] = len(library["catalog"]["procedures"])
    counts["catalog_entries"] = sum(map(len, library["catalog"]["age_groups"].values()))
    assert counts["source_text_fields"] == index["counts"]["nonempty_text_fields"] == 3323
    assert counts["source_connectors"] == 1579
    assert counts["source_tables"] == 126
    assert counts["inferred_assigned_images"] + counts["unassigned_images"] == index["counts"]["image_placements"] == 1004
    assert counts["unassigned_images"] == index["counts"]["needs_review"] == 155
    provenance = {"kind": "fresh-visio-extraction", "extraction_index_sha256": index_sha,
        "catalog_entry_policy": library["catalog"]["entry_policy"],
        "source_documents": flow_metadata, "counts": dict(counts),
        "original_media": list(media_catalog.values()), "unresolved_source_connectors": index["counts"]["unresolved_connectors"],
        "image_policy": "Original decoded pixels; ambiguous placements retained separately from instruction images."}
    write(OUTPUT / "catalog.json", library["catalog"])
    write(OUTPUT / "content-provenance.json", provenance)
    selection = {"kind": "fresh-visio-extraction", "root": "first_aid_reextracted/runtime"}
    selection_path = ROOT / "website/content/source.json"
    if not selection_path.exists() or read(selection_path) != selection:
        selection_path.write_text("{ " + json.dumps(selection, ensure_ascii=False)[1:-1] + " }\n", encoding="utf-8")
    print(json.dumps({"runtime": str(OUTPUT), "counts": dict(counts)}, indent=2))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    run()
