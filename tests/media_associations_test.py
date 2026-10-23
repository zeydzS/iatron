import importlib.util
import sys
import unittest
from pathlib import Path

path = Path(__file__).resolve().parents[1] / "scripts" / "media_associations.py"
spec = importlib.util.spec_from_file_location("media_associations", path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def shape(sid, x, y, width=2, height=2, parent=None):
    return {"node_id": sid, "original_shape_id": sid, "page_id": "p", "parent_node_id": parent,
            "geometry": {"x": x, "y": y, "width": width, "height": height, "rotation": 0}}


def node(sid, text, next_id=None, media=None):
    return {"id": sid, "text": text, "next": next_id, "input": None, "media": media or []}


class AssociationTests(unittest.TestCase):
    def test_adjacent_instruction_beats_nearer_note_and_router_center(self):
        picture = {"source_shape_id": "image", "sha256": "digest"}
        nodes = [node("instruction", "Exact source instructions", "end"),
                 node("end", "Finish"), node("router", "A", "instruction"),
                 node("note", "Illustration note", media=[picture])]
        flow = {"document_id": "procedure", "pages": [{"nodes": nodes}]}
        scheme = {"nodes": [shape("instruction", 0, 0, 10, 4), shape("end", 0, -10),
                            shape("router", 7, 3), shape("note", 7, 0), shape("image", 6, 0)]}
        reviews = module.reassociate_media(flow, scheme)
        self.assertEqual([picture], nodes[0]["media"])
        self.assertEqual([], nodes[3]["media"])
        self.assertEqual("repaired", reviews[0]["status"])
        self.assertEqual("Exact source instructions", nodes[0]["text"])

    def test_competing_boxes_keep_previous_attachment(self):
        picture = {"source_shape_id": "image", "sha256": "digest"}
        nodes = [node("left", "Left instruction", "right"), node("right", "Right instruction"),
                 node("note", "Original note", media=[picture])]
        flow = {"document_id": "procedure", "pages": [{"nodes": nodes}]}
        scheme = {"nodes": [shape("left", -2, 0), shape("right", 2, 0), shape("note", 0, 0), shape("image", 0, 0)]}
        reviews = module.reassociate_media(flow, scheme)
        self.assertEqual([picture], nodes[2]["media"])
        self.assertEqual("review_required", reviews[0]["status"])

    def test_grouped_geometry_is_not_treated_as_page_coordinates(self):
        picture = {"source_shape_id": "image", "sha256": "digest"}
        nodes = [node("instruction", "Instruction", "end"), node("end", "End"), node("note", "Note", media=[picture])]
        flow = {"document_id": "procedure", "pages": [{"nodes": nodes}]}
        scheme = {"nodes": [shape("instruction", 0, 0), shape("end", 0, -10), shape("note", 2, 0), shape("image", 2, 0, parent="group")]}
        reviews = module.reassociate_media(flow, scheme)
        self.assertEqual([picture], nodes[2]["media"])
        self.assertEqual("review_required", reviews[0]["status"])


if __name__ == "__main__":
    unittest.main()
