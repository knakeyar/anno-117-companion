from __future__ import annotations

import base64
import hashlib
import json
import re
import uuid
from collections import defaultdict
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import (
    Area,
    ManagementAction,
    Product,
    TradePlan,
    TradePlanItem,
    TradeRouteGoodObservation,
    TradeRouteLink,
    utcnow,
)


ACTIVE_PLAN_STATUSES = {"planned", "implemented", "implemented_unverified"}
ROUTE_ENDPOINT_PATTERN = re.compile(
    r"(?:^|\s)(?P<source>[A-Z0-9]{3})\s*-\s*(?P<destination>[A-Z0-9]{3})\s*$",
    flags=re.IGNORECASE,
)


def new_route_identity(session: Session, campaign_id: str, source_name: str, destination_name: str) -> tuple[str, str]:
    used = set(
        session.scalars(
            select(TradePlan.route_tag).where(
                TradePlan.campaign_id == campaign_id,
                TradePlan.route_tag.is_not(None),
            )
        ).all()
    )
    while True:
        token = base64.b32encode(uuid.uuid4().bytes).decode("ascii").rstrip("=")[:5]
        tag = f"AC-{token}"
        if tag not in used:
            break
    abbreviation = lambda value: ("".join(character for character in value if character.isalnum())[:3] or "CITY").upper()
    return tag, f"{tag} {abbreviation(source_name)}-{abbreviation(destination_name)}"


def region_key(area: Area | None) -> str | None:
    if area is None:
        return None
    evidence = f"{area.confirmed_region_guid or ''} {area.confirmed_game_session_guid or ''}".lower()
    if any(value in evidence for value in ("3225", "3245", "roman", "latium")):
        return "latium"
    if any(value in evidence for value in ("6626", "6627", "celtic", "albion")):
        return "albion"
    return None


def _tag_matches(route_name: str, route_tag: str) -> bool:
    return re.search(
        rf"(?<![A-Z0-9]){re.escape(route_tag)}(?![A-Z0-9])",
        route_name,
        flags=re.IGNORECASE,
    ) is not None


def _area_abbreviation(name: str) -> str:
    return ("".join(character for character in name if character.isalnum())[:3] or "CITY").upper()


def _route_name_parts(route_name: str) -> tuple[str, str, str] | None:
    """Read the user's ``Good SRC - DST`` naming convention without fuzzy matching."""
    match = ROUTE_ENDPOINT_PATTERN.search(route_name.strip())
    if match is None:
        return None
    label = route_name[:match.start()].strip()
    return label, match.group("source").upper(), match.group("destination").upper()


def _resolve_route_name_endpoints(
    route_name: str,
    areas: list[Area],
) -> tuple[Area, Area, str] | None:
    parts = _route_name_parts(route_name)
    if parts is None:
        return None
    label, source_code, destination_code = parts
    candidates: dict[str, list[Area]] = defaultdict(list)
    for area in areas:
        candidates[_area_abbreviation(area.latest_name or area.area_id_raw)].append(area)
    source = candidates.get(source_code, [])
    destination = candidates.get(destination_code, [])
    if len(source) != 1 or len(destination) != 1 or source[0].area_pk == destination[0].area_pk:
        return None
    return source[0], destination[0], label


def _route_runtime_status(routes: list[dict[str, Any]]) -> str:
    if any(item.get("evidence_kind") == "issue_only" for item in routes) and not any(
        item.get("evidence_kind") == "assigned_ships" for item in routes
    ):
        return "issue"
    if any(item.get("issues") for item in routes):
        return "issue"
    assigned = sum(int(item.get("assigned_ship_count") or 0) for item in routes)
    paused = sum(int(item.get("paused_ship_count") or 0) for item in routes)
    if assigned <= 0:
        return "issue" if routes else "not_detected"
    if paused >= assigned:
        return "paused"
    if paused > 0:
        return "partially_paused"
    return "running"


def _plan_edge_status(plans: list[dict[str, Any]]) -> str:
    statuses = {str(item.get("runtime_status") or "not_detected") for item in plans}
    for status in ("issue", "partially_paused", "paused", "running", "inactive"):
        if status in statuses:
            return status
    if "ambiguous" in statuses:
        return "unknown"
    return "planned"


def sync_trade_plan_runtime(
    session: Session,
    campaign_id: str | None,
    active_routes: dict[str, Any],
    *,
    telemetry_active: bool,
    telemetry_stale: bool,
) -> None:
    """Persist exact tag matches without inventing route identity or endpoints."""
    if campaign_id is None:
        return
    now = utcnow()
    route_items = active_routes.get("items") or []
    plans = session.scalars(
        select(TradePlan).where(TradePlan.campaign_id == campaign_id)
    ).all()
    existing_links = {
        link.route_key: link
        for link in session.scalars(
            select(TradeRouteLink).where(TradeRouteLink.campaign_id == campaign_id)
        ).all()
    }
    routes_by_key = {str(item.get("route_key")): item for item in route_items}
    areas = session.scalars(
        select(Area).where(Area.campaign_id == campaign_id).order_by(Area.area_pk)
    ).all()
    for route_key, link in existing_links.items():
        route = routes_by_key.get(route_key)
        if route is None:
            continue
        link.route_name = str(route.get("route_name") or link.route_name)
        link.ship_ids_json = json.dumps(sorted({
            str(ship["ship_id"]) for ship in route.get("ships") or []
        }))
        observed_at = route.get("observed_at")
        if observed_at:
            try:
                link.last_seen_at = datetime.fromisoformat(str(observed_at).replace("Z", "+00:00"))
            except (TypeError, ValueError):
                pass
    for plan in plans:
        if not plan.route_tag:
            continue
        if not telemetry_active:
            # An unload is a freshness transition, not evidence that the
            # route stopped or that its last runtime state changed.
            plan.runtime_freshness = "historical"
            continue
        matches = [item for item in route_items if _tag_matches(str(item.get("route_name") or ""), plan.route_tag)]
        live_matches = [item for item in matches if not item.get("is_stale")]
        if live_matches:
            # Old authority epochs remain queryable as history. They must not
            # make a currently observed exact tag look ambiguous.
            matches = live_matches
        matched_route_keys = {str(item.get("route_key") or "") for item in matches}
        if len(matched_route_keys) > 1:
            plan.runtime_status = "ambiguous"
            plan.runtime_freshness = "historical" if not telemetry_active else "stale" if telemetry_stale else "live"
            for link in list(existing_links.values()):
                if link.link_method == "tag" and link.trade_plan_id == plan.trade_plan_id:
                    session.delete(link)
                    existing_links.pop(link.route_key, None)
            continue
        if not matches:
            if not telemetry_active:
                plan.runtime_freshness = "historical"
            elif telemetry_stale:
                plan.runtime_freshness = "stale"
            else:
                plan.runtime_freshness = "live"
                plan.runtime_status = "inactive" if plan.last_runtime_match_at else "not_detected"
            continue

        plan.runtime_status = _route_runtime_status(matches)
        plan.runtime_freshness = "historical" if not telemetry_active else "stale" if telemetry_stale else "live"
        plan.last_runtime_match_at = now
        if plan.status == "planned" and any(
            route.get("evidence_kind") == "assigned_ships" for route in matches
        ):
            plan.status = "implemented"
        plan_tag_link = next((
            link for link in existing_links.values()
            if link.link_method == "tag" and link.trade_plan_id == plan.trade_plan_id
        ), None)
        for route in matches:
            route_key = str(route["route_key"])
            ship_ids = sorted({str(item["ship_id"]) for item in route.get("ships") or []})
            link = existing_links.get(route_key)
            if link is not None:
                link.last_seen_at = now
                if link.link_method == "tag" and link.trade_plan_id == plan.trade_plan_id:
                    link.route_name = str(route["route_name"])
                    link.ship_ids_json = json.dumps(ship_ids)
                continue
            if plan_tag_link is not None:
                existing_links.pop(plan_tag_link.route_key, None)
                plan_tag_link.route_key = route_key
                plan_tag_link.route_name = str(route["route_name"])
                plan_tag_link.ship_ids_json = json.dumps(ship_ids)
                plan_tag_link.last_seen_at = now
                plan_tag_link.updated_at = now
                existing_links[route_key] = plan_tag_link
                continue
            link = TradeRouteLink(
                link_id=str(uuid.uuid4()),
                campaign_id=campaign_id,
                route_key=route_key,
                route_name=str(route["route_name"]),
                ship_ids_json=json.dumps(ship_ids),
                trade_plan_id=plan.trade_plan_id,
                source_area_pk=plan.source_area_pk,
                destination_area_pk=plan.destination_area_pk,
                link_method="tag",
                first_seen_at=now,
                last_seen_at=now,
                updated_at=now,
            )
            session.add(link)
            existing_links[route_key] = link
            plan_tag_link = link

    # Existing Anno routes use an explicit ``Good SRC - DST`` naming convention.
    # Promote only exact, unique three-letter city aliases. Anything ambiguous
    # remains unmapped instead of being guessed.
    for route in route_items:
        route_key = str(route.get("route_key") or "")
        resolved = _resolve_route_name_endpoints(str(route.get("route_name") or ""), areas)
        if not route_key or resolved is None:
            continue
        source, destination, _label = resolved
        link = existing_links.get(route_key)
        if link is not None and link.link_method not in {"route_name"}:
            continue
        ship_ids = sorted({str(item["ship_id"]) for item in route.get("ships") or []})
        if link is None:
            link = TradeRouteLink(
                link_id=str(uuid.uuid4()),
                campaign_id=campaign_id,
                route_key=route_key,
                route_name=str(route["route_name"]),
                ship_ids_json=json.dumps(ship_ids),
                source_area_pk=source.area_pk,
                destination_area_pk=destination.area_pk,
                link_method="route_name",
                first_seen_at=now,
                last_seen_at=now,
                updated_at=now,
            )
            session.add(link)
            existing_links[route_key] = link
        else:
            link.route_name = str(route["route_name"])
            link.ship_ids_json = json.dumps(ship_ids)
            link.source_area_pk = source.area_pk
            link.destination_area_pk = destination.area_pk
            link.last_seen_at = now
            link.updated_at = now
    session.flush()


def _edge_id(campaign_id: str, source_area_pk: int, destination_area_pk: int) -> str:
    digest = hashlib.sha256(
        f"{campaign_id}|{source_area_pk}|{destination_area_pk}".encode()
    ).hexdigest()[:20]
    return f"trade-{digest}"


def _product_names(session: Session, product_guids: set[str]) -> dict[str, str]:
    if not product_guids:
        return {}
    rows = session.scalars(
        select(Product).where(Product.product_guid.in_(product_guids)).order_by(Product.release_id)
    ).all()
    return {item.product_guid: item.name for item in rows}


def route_link_dict(session: Session, link: TradeRouteLink) -> dict[str, Any]:
    source = session.get(Area, link.source_area_pk)
    destination = session.get(Area, link.destination_area_pk)
    return {
        "link_id": link.link_id,
        "campaign_id": link.campaign_id,
        "route_key": link.route_key,
        "route_name": link.route_name,
        "ship_ids": json.loads(link.ship_ids_json or "[]"),
        "trade_plan_id": link.trade_plan_id,
        "source_area_pk": link.source_area_pk,
        "source_area_name": source.latest_name or source.area_id_raw if source else str(link.source_area_pk),
        "destination_area_pk": link.destination_area_pk,
        "destination_area_name": destination.latest_name or destination.area_id_raw if destination else str(link.destination_area_pk),
        "link_method": link.link_method,
        "first_seen_at": link.first_seen_at.isoformat(),
        "last_seen_at": link.last_seen_at.isoformat(),
        "updated_at": link.updated_at.isoformat(),
    }


def build_trade_network(
    session: Session,
    campaign_id: str | None,
    active_routes: dict[str, Any],
    inventory: dict[str, Any],
    meta: dict[str, Any],
    *,
    telemetry_active: bool,
) -> dict[str, Any]:
    empty_graph = {"nodes": [], "edges": []}
    if campaign_id is None:
        return {
            "meta": meta,
            "catalog": inventory.get("catalog", {}),
            "campaign_id": None,
            "graphs": {"latium": empty_graph, "albion": empty_graph, "cross_region": empty_graph},
            "unmapped_routes": [],
            "capabilities": active_routes.get("capabilities", {}),
            "evidence_notice": "No campaign is selected.",
        }

    areas = session.scalars(
        select(Area).where(Area.campaign_id == campaign_id).order_by(Area.latest_name, Area.area_pk)
    ).all()
    area_by_pk = {item.area_pk: item for item in areas}
    plans = session.scalars(
        select(TradePlan).where(TradePlan.campaign_id == campaign_id).order_by(TradePlan.created_at)
    ).all()
    plan_by_id = {item.trade_plan_id: item for item in plans}
    plan_items = session.scalars(
        select(TradePlanItem).where(TradePlanItem.trade_plan_id.in_(list(plan_by_id)))
    ).all() if plan_by_id else []
    items_by_plan: dict[str, list[TradePlanItem]] = defaultdict(list)
    for item in plan_items:
        items_by_plan[item.trade_plan_id].append(item)
    good_observations = []
    if meta.get("snapshot_id") is not None:
        good_observations = session.scalars(
            select(TradeRouteGoodObservation).where(
                TradeRouteGoodObservation.snapshot_id == int(meta["snapshot_id"])
            )
        ).all()
    product_names = _product_names(
        session,
        {item.product_guid for item in plan_items} | {item.product_guid for item in good_observations},
    )
    release_id = (inventory.get("catalog") or {}).get("release_id")
    catalog_products = session.scalars(
        select(Product).where(Product.release_id == release_id).order_by(Product.product_guid)
    ).all() if release_id else []
    catalog_product_by_name: dict[str, Product | None] = {}
    for product in catalog_products:
        key = " ".join(product.name.casefold().split())
        catalog_product_by_name[key] = None if key in catalog_product_by_name else product
    goods_by_route: dict[str, list[TradeRouteGoodObservation]] = defaultdict(list)
    for observation in good_observations:
        goods_by_route[observation.route_name.casefold()].append(observation)

    links = session.scalars(
        select(TradeRouteLink).where(TradeRouteLink.campaign_id == campaign_id)
    ).all()
    action_rows = session.scalars(
        select(ManagementAction).where(
            ManagementAction.campaign_id == campaign_id,
            ManagementAction.status.in_(["active", "accepted", "snoozed"]),
        )
    ).all()
    routes_by_key = {str(item["route_key"]): item for item in active_routes.get("items") or []}
    linked_route_keys = {item.route_key for item in links}
    edge_state: dict[tuple[int, int], dict[str, Any]] = {}

    def edge_for(source_pk: int, destination_pk: int) -> dict[str, Any]:
        key = (source_pk, destination_pk)
        if key not in edge_state:
            edge_state[key] = {
                "edge_id": _edge_id(campaign_id, source_pk, destination_pk),
                "source_area_pk": source_pk,
                "source_area_name": (area_by_pk[source_pk].latest_name or area_by_pk[source_pk].area_id_raw),
                "destination_area_pk": destination_pk,
                "destination_area_name": (area_by_pk[destination_pk].latest_name or area_by_pk[destination_pk].area_id_raw),
                "status": "planned",
                "severity": "stable",
                "freshness": "historical",
                "goods_verification": "unavailable",
                "endpoint_evidence": [],
                "plans": [],
                "routes": [],
                "ships": [],
                "planned_goods": [],
                "route_name_goods": [],
                "configured_goods": [],
                "cargo_aboard": [],
                "issues": [],
                "actions": [],
            }
        return edge_state[key]

    for plan in plans:
        if plan.status not in ACTIVE_PLAN_STATUSES:
            continue
        if plan.source_area_pk not in area_by_pk or plan.destination_area_pk not in area_by_pk:
            continue
        edge = edge_for(plan.source_area_pk, plan.destination_area_pk)
        goods = [
            {
                "product_guid": item.product_guid,
                "product_name": product_names.get(item.product_guid),
                "amount": item.amount,
                "evidence_kind": "planned",
                "trade_plan_id": plan.trade_plan_id,
            }
            for item in sorted(items_by_plan[plan.trade_plan_id], key=lambda value: product_names.get(value.product_guid, value.product_guid))
        ]
        edge["plans"].append({
            "trade_plan_id": plan.trade_plan_id,
            "plan_kind": plan.plan_kind,
            "workflow_status": plan.status,
            "runtime_status": plan.runtime_status,
            "runtime_freshness": plan.runtime_freshness,
            "route_tag": plan.route_tag,
            "suggested_route_name": plan.suggested_route_name,
            "reason": plan.reason,
            "goods": goods,
        })
        edge["planned_goods"].extend(goods)
        edge["endpoint_evidence"].append({"kind": "companion_plan", "trade_plan_id": plan.trade_plan_id})

    for link in links:
        if link.source_area_pk not in area_by_pk or link.destination_area_pk not in area_by_pk:
            continue
        edge = edge_for(link.source_area_pk, link.destination_area_pk)
        edge["endpoint_evidence"].append({"kind": link.link_method, "link_id": link.link_id})
        route = routes_by_key.get(link.route_key)
        if route is not None and not any(item["route_key"] == route["route_key"] for item in edge["routes"]):
            edge["routes"].append(route)
            edge["ships"].extend(route.get("ships") or [])
            edge["issues"].extend(route.get("issues") or [])
            parts = _route_name_parts(str(route.get("route_name") or ""))
            named_product = catalog_product_by_name.get(" ".join(parts[0].casefold().split())) if parts else None
            if named_product is not None:
                edge["route_name_goods"].append({
                    "product_guid": named_product.product_guid,
                    "product_name": named_product.name,
                    "amount": None,
                    "evidence_kind": "route_name_label",
                })
            for observation in goods_by_route.get(str(route.get("route_name") or "").casefold(), []):
                good = {
                    "product_guid": observation.product_guid,
                    "product_name": product_names.get(observation.product_guid),
                    "amount": observation.amount,
                    "ship_id": observation.ship_id_raw,
                    "area_id": observation.area_id_raw,
                    "stop_ordinal": observation.stop_ordinal,
                    "evidence_kind": observation.evidence_kind,
                    "observed_at": observation.observed_at.isoformat(),
                }
                if observation.evidence_kind == "configured_good":
                    edge["configured_goods"].append(good)
                elif observation.evidence_kind == "cargo_aboard":
                    edge["cargo_aboard"].append(good)

    signals_by_area: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for signal in inventory.get("signals") or []:
        if signal.get("area_pk") is not None:
            signals_by_area[int(signal["area_pk"])].append(signal)

    edges: list[dict[str, Any]] = []
    for (source_pk, destination_pk), edge in edge_state.items():
        routes = edge["routes"]
        if routes:
            edge["status"] = _route_runtime_status(routes)
            edge["freshness"] = "historical" if not telemetry_active else "stale" if all(item.get("is_stale") for item in routes) else "live"
        elif edge["plans"]:
            edge["status"] = _plan_edge_status(edge["plans"])
            edge["freshness"] = max(
                (item["runtime_freshness"] for item in edge["plans"]),
                key=lambda value: {"historical": 0, "stale": 1, "live": 2}.get(value, 0),
            )
        else:
            edge["status"] = "historical"
            edge["freshness"] = "historical"
        if edge["configured_goods"]:
            edge["goods_verification"] = "configured"
        elif edge["planned_goods"]:
            edge["goods_verification"] = "planned_only"
        elif edge["route_name_goods"]:
            edge["goods_verification"] = "route_name_only"
        critical_pressure = any(
            item.get("severity") == "critical"
            and (not edge["planned_goods"] or item.get("product_guid") in {good["product_guid"] for good in edge["planned_goods"]})
            for item in signals_by_area[destination_pk]
        )
        edge["severity"] = "critical" if edge["issues"] or critical_pressure else "stable"
        route_names = {str(item.get("route_name") or "").casefold() for item in edge["routes"]}
        for action in action_rows:
            evidence = json.loads(action.evidence_json or "{}")
            matches_pair = (
                evidence.get("source_area_pk") == source_pk
                and evidence.get("destination_area_pk") == destination_pk
            )
            matches_route = str(evidence.get("route_name") or "").casefold() in route_names
            if matches_pair or matches_route:
                edge["actions"].append({
                    "action_id": action.action_id,
                    "kind": action.kind,
                    "severity": action.severity,
                    "title": action.title,
                    "summary": action.summary,
                    "status": action.status,
                    "deep_link": action.deep_link,
                })
        edge["summary"] = {
            "goods": len({
                item["product_guid"]
                for item in edge["planned_goods"] + edge["route_name_goods"] + edge["configured_goods"]
            }),
            "routes": len(edge["routes"]),
            "ships": len({item["ship_id"] for item in edge["ships"]}),
            "plans": len(edge["plans"]),
        }
        edge["endpoint_evidence"] = list({json.dumps(item, sort_keys=True): item for item in edge["endpoint_evidence"]}.values())
        edges.append(edge)

    inventory_by_area: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for item in inventory.get("items") or []:
        inventory_by_area[int(item["area_pk"])].append(item)
    node_edges: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for edge in edges:
        node_edges[edge["source_area_pk"]].append(edge)
        node_edges[edge["destination_area_pk"]].append(edge)

    nodes = []
    for area in areas:
        connected = node_edges[area.area_pk]
        signals = signals_by_area[area.area_pk]
        critical = sum(item.get("severity") == "critical" for item in signals)
        warning = sum(item.get("severity") == "warning" for item in signals)
        route_issues = [issue for edge in connected for issue in edge["issues"]]
        route_critical = any(issue.get("severity") == "critical" for issue in route_issues)
        route_warning = bool(route_issues)
        tracked = inventory_by_area[area.area_pk]
        fill_values = [float(item["fill_ratio"]) for item in tracked if item.get("fill_ratio") is not None]
        severity_rank = {"critical": 0, "warning": 1, "info": 2}
        pressure_signals = sorted(
            signals,
            key=lambda item: (
                severity_rank.get(str(item.get("severity")), 3),
                -int(item.get("priority") or 0),
                str(item.get("product_name") or item.get("product_guid") or ""),
            ),
        )
        pressured_products = {
            str(item.get("product_guid")): index for index, item in enumerate(pressure_signals)
        }
        important_goods = sorted(
            tracked,
            key=lambda item: (
                pressured_products.get(str(item.get("product_guid")), len(pressured_products) + 1),
                float(item.get("fill_ratio")) if item.get("fill_ratio") is not None else 2.0,
                str(item.get("product_name") or item.get("product_guid") or ""),
            ),
        )[:6]
        nodes.append({
            "node_id": f"area-{area.area_pk}",
            "area_pk": area.area_pk,
            "area_name": area.latest_name or area.area_id_raw,
            "region": region_key(area),
            "severity": "critical" if critical or route_critical else "warning" if warning or route_warning else "stable",
            "pressure_count": len(signals),
            "route_issue_count": len(route_issues),
            "running_route_count": sum(
                route.get("status") == "running"
                for item in connected for route in item["routes"]
            ),
            "paused_route_count": sum(
                route.get("status") in {"paused", "partially_paused"}
                for item in connected for route in item["routes"]
            ),
            "planned_route_count": sum(
                plan.get("runtime_status") == "not_detected"
                for item in connected for plan in item["plans"]
            ),
            "stock_health": {
                "tracked_goods": len(tracked),
                "average_fill_ratio": round(sum(fill_values) / len(fill_values), 4) if fill_values else None,
                "critical": critical,
                "warning": warning,
            },
            "important_goods": [{
                "product_guid": item.get("product_guid"),
                "product_name": item.get("product_name"),
                "stock": item.get("stock"),
                "capacity": item.get("capacity"),
                "fill_ratio": item.get("fill_ratio"),
                "net_stock_change_per_minute": (item.get("velocity") or {}).get("net_stock_change_per_minute"),
            } for item in important_goods],
            "pressure_signals": pressure_signals[:6],
        })

    nodes_by_region = {
        "latium": [item for item in nodes if item["region"] == "latium"],
        "albion": [item for item in nodes if item["region"] == "albion"],
    }
    intra = {"latium": [], "albion": []}
    cross_edges = []
    for edge in edges:
        source_region = region_key(area_by_pk[edge["source_area_pk"]])
        destination_region = region_key(area_by_pk[edge["destination_area_pk"]])
        if {source_region, destination_region} == {"latium", "albion"}:
            edge["scope"] = "cross_region"
        elif source_region is not None and source_region == destination_region:
            edge["scope"] = source_region
        else:
            edge["scope"] = "unknown"
        if edge["scope"] == "cross_region":
            cross_edges.append(edge)
        elif edge["scope"] in intra:
            intra[edge["scope"]].append(edge)
    route_freshness = "historical" if not telemetry_active else "stale" if bool(meta.get("is_stale", True)) else "live"
    missing_links = [link for link in links if link.route_key not in routes_by_key]
    unmapped = []
    for item in active_routes.get("items") or []:
        if str(item["route_key"]) in linked_route_keys:
            continue
        observed_ship_ids = {str(ship["ship_id"]) for ship in item.get("ships") or []}
        suggestions = []
        if observed_ship_ids:
            for link in missing_links:
                saved_ship_ids = set(json.loads(link.ship_ids_json or "[]"))
                overlap = sorted(observed_ship_ids & saved_ship_ids)
                if overlap:
                    suggestions.append({
                        "link_id": link.link_id,
                        "previous_route_name": link.route_name,
                        "overlapping_ship_ids": overlap,
                        "requires_confirmation": True,
                    })
        unmapped.append({
            **item,
            "freshness": route_freshness,
            "relink_suggestions": suggestions,
        })
    return {
        "meta": meta,
        "catalog": inventory.get("catalog", {}),
        "campaign_id": campaign_id,
        "graphs": {
            "latium": {"nodes": nodes_by_region["latium"], "edges": intra["latium"]},
            "albion": {"nodes": nodes_by_region["albion"], "edges": intra["albion"]},
            "cross_region": {"nodes": nodes_by_region["latium"] + nodes_by_region["albion"], "edges": cross_edges},
        },
        "unmapped_routes": unmapped,
        "capabilities": active_routes.get("capabilities", {}),
        "evidence_notice": "Observed routes auto-link only when their exact three-letter city aliases are unique. Goods read from route names are labels, not verified route configuration or cargo.",
    }
