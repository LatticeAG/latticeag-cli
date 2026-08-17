import json
from pathlib import Path

from latticeag_events import parse_envelope

FIXTURES = Path(__file__).resolve().parents[2] / "fixtures"


def _name(event: object) -> str:
    if isinstance(event, dict):
        name = event["name"]
        assert isinstance(name, str)
        return name
    name = getattr(event, "name")
    assert isinstance(name, str)
    return name


def test_parse_belief_extracted() -> None:
    data = json.loads((FIXTURES / "belief_extracted.json").read_text())
    event = parse_envelope(data)
    assert event is not None
    assert _name(event) == "belief_extracted"


def test_unknown_name_returns_object() -> None:
    data = json.loads((FIXTURES / "belief_extracted.json").read_text())
    data["name"] = "not_a_real_event"
    event = parse_envelope(data)
    assert event is not None
    assert _name(event) == "not_a_real_event"
