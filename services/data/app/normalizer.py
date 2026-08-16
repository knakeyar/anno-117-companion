from __future__ import annotations

import json
import hashlib
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from .models import (
    Area,
    AreaBuildingCurrent,
    AreaBuildingObservation,
    AreaLocation,
    AreaPopulationObservation,
    AreaProductCurrent,
    AreaProductObservation,
    AreaSnapshot,
    AreaWorkforceObservation,
    ActiveTradeRouteCurrent,
    ActiveTradeRouteShipCurrent,
    Campaign,
    FinanceCategoryObservation,
    ParticipantFinanceObservation,
    PlaySession,
    SnapshotBatch,
    SnapshotSectionStatus,
    StaticRelease,
    TelemetryRaw,
    TradeRouteIssueObservation,
    TradeRouteShipObservation,
    utcnow,
)


@dataclass(slots=True)
class NormalizationResult:
    completed_snapshot_id: int | None = None


def _text(value: Any) -> str | None:
    return None if value is None else str(value)


def _float(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _int(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def _bool(value: Any) -> bool | None:
    return value if isinstance(value, bool) else None


def _pick(*values: Any) -> Any:
    return next((value for value in values if value is not None), None)


def _first_release(session: Session, requested: str | None) -> StaticRelease:
    release = session.get(StaticRelease, requested) if requested else None
    if release is None:
        release = session.scalars(select(StaticRelease).order_by(StaticRelease.imported_at.desc())).first()
    if release is None:
        raise RuntimeError("no static catalog release has been imported")
    return release


def _transport_key(raw: TelemetryRaw) -> str:
    return f"{raw.source_path}|{raw.source_fingerprint}"


def _find_play_session(session: Session, raw: TelemetryRaw, envelope: dict) -> PlaySession | None:
    load_epoch = _int(envelope.get("load_epoch"))
    if load_epoch is not None:
        found = session.scalar(
            select(PlaySession).where(
                PlaySession.transport_key == _transport_key(raw),
                PlaySession.load_epoch == load_epoch,
            )
        )
        if found is not None:
            return found
    return session.scalar(
        select(PlaySession).where(PlaySession.is_current.is_(True)).order_by(PlaySession.started_at.desc())
    )


def _open_play_session(session: Session, raw: TelemetryRaw, envelope: dict) -> PlaySession:
    load_epoch = _int(envelope.get("load_epoch")) or 0
    existing = session.scalar(
        select(PlaySession).where(
            PlaySession.transport_key == _transport_key(raw),
            PlaySession.load_epoch == load_epoch,
        )
    )
    if existing is not None:
        existing.is_current = True
        raw.play_session_id = existing.play_session_id
        return existing

    now = raw.received_at
    session.execute(
        update(PlaySession)
        .where(PlaySession.is_current.is_(True))
        .values(is_current=False, ended_at=now)
    )
    release = _first_release(session, _text(envelope.get("catalog_release")))
    play = PlaySession(
        play_session_id=str(uuid.uuid4()),
        static_release_id=release.release_id,
        transport_key=_transport_key(raw),
        load_epoch=load_epoch,
        mod_version=_text(envelope.get("mod_version") or envelope.get("probe_version")),
        started_at=now,
        is_current=True,
    )
    session.add(play)
    session.flush()
    raw.play_session_id = play.play_session_id
    return play


def _ensure_campaign(session: Session, play: PlaySession, context: dict) -> Campaign:
    seed = _text(_pick(context.get("game_seed"), context.get("game_setup", {}).get("GameSeed")))
    participant = _text(
        _pick(
            context.get("participant_guid"),
            context.get("participant", {}).get("GetCurrentParticipantGUID"),
        )
    )
    identity_key = f"seed:{seed or 'unknown'}|participant:{participant or 'unknown'}"
    assigned = session.get(Campaign, play.campaign_id) if play.campaign_id else None
    if assigned is not None and assigned.identity_key != identity_key:
        # A user may explicitly assign this authority epoch to another campaign.
        # Keep that decision stable for the rest of the load rather than letting
        # each subsequent snapshot restore the provisional evidence match.
        play.game_seed = seed
        play.participant_guid = participant
        return assigned
    campaign = session.scalar(select(Campaign).where(Campaign.identity_key == identity_key))
    if campaign is None:
        campaign = Campaign(
            campaign_id=str(uuid.uuid4()),
            display_name=f"Unassigned campaign {seed or 'unknown'}",
            identity_key=identity_key,
            game_seed=seed,
            participant_guid=participant,
            identity_method="game_seed_participant",
            identity_confidence="provisional",
        )
        session.add(campaign)
        session.flush()
    play.campaign_id = campaign.campaign_id
    play.game_seed = seed
    play.participant_guid = participant
    return campaign


def _ensure_snapshot(
    session: Session,
    play: PlaySession,
    sequence: int,
    received_at: datetime,
) -> SnapshotBatch:
    snapshot = session.scalar(
        select(SnapshotBatch).where(
            SnapshotBatch.play_session_id == play.play_session_id,
            SnapshotBatch.snapshot_sequence == sequence,
        )
    )
    if snapshot is None:
        snapshot = SnapshotBatch(
            play_session_id=play.play_session_id,
            snapshot_sequence=sequence,
            received_at=received_at,
        )
        session.add(snapshot)
        session.flush()
    return snapshot


def _materialize_current_state(session: Session, play: PlaySession, snapshot: SnapshotBatch) -> None:
    """Advance campaign current state only for a completed atomic batch."""
    if not snapshot.is_complete or play.campaign_id is None:
        return
    observed_at = snapshot.completed_at or snapshot.received_at
    products = session.scalars(
        select(AreaProductObservation).where(AreaProductObservation.snapshot_id == snapshot.snapshot_id)
    ).all()
    for item in products:
        current = session.get(AreaProductCurrent, (item.area_pk, item.product_guid))
        if current is None:
            current = AreaProductCurrent(
                area_pk=item.area_pk,
                product_guid=item.product_guid,
                campaign_id=play.campaign_id,
                play_session_id=play.play_session_id,
                snapshot_id=snapshot.snapshot_id,
                observed_at=observed_at,
            )
            session.add(current)
        current.campaign_id = play.campaign_id
        current.play_session_id = play.play_session_id
        current.snapshot_id = snapshot.snapshot_id
        current.stock = item.stock
        current.available_stock = item.available_stock
        current.storage_capacity = item.storage_capacity
        current.reserved_amount = item.reserved_amount
        current.free_space_raw = item.free_space_raw
        current.engine_trend_raw = item.engine_trend_raw
        current.passive_trade_minimum = item.passive_trade_minimum
        current.offer_is_no_offer = item.offer_is_no_offer
        current.offer_is_buy_only = item.offer_is_buy_only
        current.offer_is_sell_only = item.offer_is_sell_only
        current.offer_is_buy_or_sell = item.offer_is_buy_or_sell
        current.offer_is_preferred_good = item.offer_is_preferred_good
        current.observed_at = observed_at
        current.last_attempt_snapshot_id = snapshot.snapshot_id
        current.section_status = "success"

    buildings = session.scalars(
        select(AreaBuildingObservation).where(AreaBuildingObservation.snapshot_id == snapshot.snapshot_id)
    ).all()
    emitted = {(item.area_pk, item.building_guid): item for item in buildings}
    area_rows = session.scalars(
        select(AreaSnapshot).where(AreaSnapshot.snapshot_id == snapshot.snapshot_id)
    ).all()
    release_id = play.static_release_id
    from .models import BuildingType  # local import keeps the model list readable
    catalog_buildings = session.scalars(
        select(BuildingType).where(BuildingType.release_id == release_id)
    ).all()
    for area_row in area_rows:
        section = session.scalar(
            select(SnapshotSectionStatus).where(
                SnapshotSectionStatus.snapshot_id == snapshot.snapshot_id,
                SnapshotSectionStatus.section_name == "buildings",
                SnapshotSectionStatus.area_id_raw == session.get(Area, area_row.area_pk).area_id_raw,
            )
        )
        if section is None or section.status != "success":
            continue
        targets = catalog_buildings if snapshot.section_mode in {"baseline", "reconciliation", "full"} else []
        keys = {(area_row.area_pk, item.building_guid) for item in targets} | {
            key for key in emitted if key[0] == area_row.area_pk
        }
        for key in keys:
            change = emitted.get(key)
            count = change.building_count if change else 0
            current = session.get(AreaBuildingCurrent, key)
            if current is None:
                current = AreaBuildingCurrent(
                    area_pk=key[0],
                    building_guid=key[1],
                    campaign_id=play.campaign_id,
                    play_session_id=play.play_session_id,
                    snapshot_id=snapshot.snapshot_id,
                )
                session.add(current)
            current.campaign_id = play.campaign_id
            current.play_session_id = play.play_session_id
            current.snapshot_id = snapshot.snapshot_id
            current.building_count = count
            current.presence_status = "installed" if count > 0 else "not_installed"
            current.observed_at = observed_at
            current.last_attempt_snapshot_id = snapshot.snapshot_id

    route_section = session.scalar(
        select(SnapshotSectionStatus).where(
            SnapshotSectionStatus.snapshot_id == snapshot.snapshot_id,
            SnapshotSectionStatus.section_name == "active_routes",
            SnapshotSectionStatus.area_id_raw.is_(None),
        )
    )
    if route_section is None or route_section.status != "success":
        return

    route_scope = snapshot.current_game_session_guid
    scope_query = select(ActiveTradeRouteCurrent).where(
        ActiveTradeRouteCurrent.campaign_id == play.campaign_id,
        ActiveTradeRouteCurrent.game_session_guid == route_scope
        if route_scope is not None
        else ActiveTradeRouteCurrent.game_session_guid.is_(None),
    )
    previous_routes = session.scalars(scope_query).all()
    for route in previous_routes:
        route.is_active = False
        route.snapshot_id = snapshot.snapshot_id
        route.play_session_id = play.play_session_id
        session.execute(
            delete(ActiveTradeRouteShipCurrent).where(
                ActiveTradeRouteShipCurrent.route_key == route.route_key
            )
        )

    observed_ships = session.scalars(
        select(TradeRouteShipObservation).where(
            TradeRouteShipObservation.snapshot_id == snapshot.snapshot_id
        )
    ).all()
    grouped: dict[tuple[str | None, str], list[TradeRouteShipObservation]] = {}
    for ship in observed_ships:
        ship_scope = ship.game_session_guid or route_scope
        grouped.setdefault((ship_scope, ship.route_name), []).append(ship)

    for (ship_scope, route_name), ships in grouped.items():
        route_key = hashlib.sha256(
            f"{play.campaign_id}|{ship_scope or 'unknown'}|{route_name}".encode()
        ).hexdigest()
        route = session.get(ActiveTradeRouteCurrent, route_key)
        if route is None:
            route = ActiveTradeRouteCurrent(
                route_key=route_key,
                campaign_id=play.campaign_id,
                route_name=route_name,
                game_session_guid=ship_scope,
                play_session_id=play.play_session_id,
                snapshot_id=snapshot.snapshot_id,
                first_seen_at=observed_at,
                last_seen_at=observed_at,
            )
            session.add(route)
        route.route_name = route_name
        route.game_session_guid = ship_scope
        route.region_guid = snapshot.current_region_guid if ship_scope == route_scope else None
        route.play_session_id = play.play_session_id
        route.snapshot_id = snapshot.snapshot_id
        route.assigned_ship_count = len(ships)
        route.paused_ship_count = sum(item.is_paused is True for item in ships)
        route.regular_ship_count = sum(item.on_regular_route is True for item in ships)
        route.is_active = True
        route.last_seen_at = observed_at
        session.flush()
        session.execute(
            delete(ActiveTradeRouteShipCurrent).where(
                ActiveTradeRouteShipCurrent.route_key == route.route_key
            )
        )
        for ship in ships:
            session.add(ActiveTradeRouteShipCurrent(
                route_key=route.route_key,
                ship_id_raw=ship.ship_id_raw,
                ship_guid=ship.ship_guid,
                owner_guid=ship.owner_guid,
                game_session_guid=ship.game_session_guid,
                area_id_raw=ship.area_id_raw,
                is_paused=ship.is_paused,
                on_regular_route=ship.on_regular_route,
                loading_speed_factor=ship.loading_speed_factor,
                observed_at=observed_at,
            ))


def refresh_materialized_state(session: Session, campaign_id: str | None = None) -> None:
    query = (
        select(SnapshotBatch)
        .join(PlaySession, PlaySession.play_session_id == SnapshotBatch.play_session_id)
        .where(SnapshotBatch.is_complete.is_(True))
        .order_by(SnapshotBatch.completed_at, SnapshotBatch.received_at, SnapshotBatch.snapshot_id)
    )
    if campaign_id is not None:
        query = query.where(PlaySession.campaign_id == campaign_id)
    for snapshot in session.scalars(query).all():
        play = session.get(PlaySession, snapshot.play_session_id)
        if play is not None:
            _materialize_current_state(session, play, snapshot)
            session.flush()
    session.flush()


def _normalise_location(session: Session, area: Area, data: dict, observed_at: datetime) -> None:
    location_data = data.get("location") or {}
    location = session.get(AreaLocation, area.area_pk)
    if location is None:
        location = AreaLocation(area_pk=area.area_pk)
        session.add(location)
    location.kontor_id_raw = _text(location_data.get("kontor_id"))
    location.observation_status = _text(location_data.get("status")) or "not_observed"
    location.observation_error = _text(location_data.get("error"))
    if location.observation_status == "success":
        location.observed_x = _float(location_data.get("x"))
        location.observed_y = _float(location_data.get("y"))
        location.observed_session_guid = _text(location_data.get("session_guid"))
        location.observed_region_guid = _text(location_data.get("region_guid"))
        location.observed_at = observed_at
        if location.observed_region_guid:
            area.confirmed_region_guid = location.observed_region_guid
        if location.observed_session_guid:
            area.confirmed_game_session_guid = location.observed_session_guid
        area.region_evidence = "kontor_game_object"


def _snapshot_for_event(session: Session, raw: TelemetryRaw, envelope: dict) -> tuple[PlaySession, SnapshotBatch]:
    play = _find_play_session(session, raw, envelope)
    if play is None:
        play = _open_play_session(session, raw, envelope)
    raw.play_session_id = play.play_session_id
    sequence = _int(envelope.get("snapshot_sequence") or envelope.get("sample_number")) or 0
    snapshot = _ensure_snapshot(session, play, sequence, raw.received_at)
    raw.snapshot_id = snapshot.snapshot_id
    return play, snapshot


def _section_status(
    session: Session,
    snapshot: SnapshotBatch,
    section: str,
    status: str,
    *,
    area_id: str | None = None,
    reported_count: int | None = None,
    captured_count: int | None = None,
    truncated: bool | None = None,
    errors: Any = None,
) -> None:
    query = select(SnapshotSectionStatus).where(
        SnapshotSectionStatus.snapshot_id == snapshot.snapshot_id,
        SnapshotSectionStatus.section_name == section,
    )
    query = query.where(
        SnapshotSectionStatus.area_id_raw == area_id
        if area_id is not None
        else SnapshotSectionStatus.area_id_raw.is_(None)
    )
    item = session.scalar(query)
    if item is None:
        item = SnapshotSectionStatus(
            snapshot_id=snapshot.snapshot_id,
            section_name=section,
            area_id_raw=area_id,
            status=status,
        )
        session.add(item)
    item.status = status
    item.reported_count = reported_count
    item.captured_count = captured_count
    item.truncated = truncated
    item.error_json = json.dumps(errors, ensure_ascii=False, sort_keys=True) if errors else None


def _ensure_area(session: Session, campaign: Campaign, data: dict, observed_at: datetime) -> Area:
    raw_id = _text(_pick(data.get("area_id"), data.get("id_string"), data.get("ID")))
    if raw_id is None:
        raise ValueError("area event has no area ID")
    area = session.scalar(
        select(Area).where(Area.campaign_id == campaign.campaign_id, Area.area_id_raw == raw_id)
    )
    if area is None:
        area = Area(campaign_id=campaign.campaign_id, area_id_raw=raw_id)
        session.add(area)
        session.flush()
    area.latest_name = _text(_pick(data.get("CityName"), data.get("name"), area.latest_name))
    area.last_seen_at = observed_at
    return area


def _upsert_area_snapshot(
    session: Session,
    snapshot: SnapshotBatch,
    campaign: Campaign,
    data: dict,
) -> tuple[Area, AreaSnapshot]:
    area = _ensure_area(session, campaign, data, snapshot.received_at)
    if data.get("is_current_area") is True or snapshot.current_area_id_raw == area.area_id_raw:
        area.confirmed_region_guid = snapshot.current_region_guid
        area.confirmed_game_session_guid = snapshot.current_game_session_guid
        area.region_evidence = "current_camera_area_same_snapshot"

    observed = session.get(AreaSnapshot, (snapshot.snapshot_id, area.area_pk))
    if observed is None:
        observed = AreaSnapshot(snapshot_id=snapshot.snapshot_id, area_pk=area.area_pk)
        session.add(observed)
    observed.observed_name = _text(_pick(data.get("CityName"), data.get("name")))
    observed.owner_participant_guid = _text(data.get("Owner"))
    observed.owner_name = _text(data.get("OwnerName"))
    observed.owned_by_current_player = _bool(data.get("IsOwnedByCurrentParticipant"))
    observed.has_area_economy = _bool(data.get("HasAreaEconomy"))

    population = data.get("population") or {}
    summary = population.get("summary") or {}
    area_money = population.get("area_money") or data.get("area_money") or {}
    observed.population_total = _float(_pick(summary.get("PopulationCount"), data.get("population_total")))
    observed.residence_count = _float(_pick(summary.get("AmountOfResidences"), data.get("residence_count")))
    observed.city_status_raw = _text(_pick(summary.get("CityStatus"), summary.get("CityStatusName")))
    observed.area_balance = _float(_pick(area_money.get("TotalMoneyIncome"), data.get("area_balance")))
    observed.land_tax = _float(_pick(area_money.get("LandTax"), data.get("land_tax")))
    session.flush()
    return area, observed


def _normalise_products(session: Session, snapshot: SnapshotBatch, area: Area, products: list[dict]) -> None:
    for product in products:
        guid = _text(product.get("product_guid"))
        if guid is None:
            continue
        key = (snapshot.snapshot_id, area.area_pk, guid)
        if session.get(AreaProductObservation, key) is not None:
            continue
        trade = product.get("passive_trade") or {}
        offer = trade.get("offer") or {}
        session.add(
            AreaProductObservation(
                snapshot_id=snapshot.snapshot_id,
                area_pk=area.area_pk,
                product_guid=guid,
                stock=_float(_pick(product.get("stock"), product.get("storage", {}).get("stock"))),
                available_stock=_float(_pick(product.get("available"), product.get("storage", {}).get("available"))),
                storage_capacity=_float(_pick(product.get("capacity"), product.get("storage", {}).get("capacity"))),
                reserved_amount=_float(_pick(product.get("reserved"), product.get("storage", {}).get("reserved"))),
                free_space_raw=_float(_pick(product.get("free_space_raw"), product.get("storage", {}).get("free_space"))),
                engine_trend_raw=_float(_pick(product.get("engine_trend_raw"), product.get("storage", {}).get("engine_trend"))),
                passive_trade_minimum=_float(trade.get("minimum_stock")),
                offer_is_no_offer=_bool(offer.get("IsNoOffer")),
                offer_is_buy_only=_bool(offer.get("IsBuyOnly")),
                offer_is_sell_only=_bool(offer.get("IsSellOnly")),
                offer_is_buy_or_sell=_bool(offer.get("IsBuyOrSell")),
                offer_is_preferred_good=_bool(offer.get("IsPreferedGood")),
            )
        )


def _normalise_population(session: Session, snapshot: SnapshotBatch, area: Area, population: dict) -> None:
    for index, level in enumerate(population.get("levels") or [], start=1):
        guid = _text(_pick(level.get("Guid"), level.get("population_guid")))
        if guid is None:
            continue
        key = (snapshot.snapshot_id, area.area_pk, guid)
        if session.get(AreaPopulationObservation, key) is not None:
            continue
        session.add(
            AreaPopulationObservation(
                snapshot_id=snapshot.snapshot_id,
                area_pk=area.area_pk,
                population_guid=guid,
                ordinal=_int(level.get("ordinal")) or index,
                localized_name=_text(_pick(level.get("Text"), level.get("name"))),
                population_count=_float(level.get("population_count")),
                satisfaction=_float(level.get("satisfaction")),
            )
        )


def _normalise_workforce(session: Session, snapshot: SnapshotBatch, area: Area, workforce: dict) -> None:
    for index, item in enumerate(workforce.get("items") or workforce.get("workforces") or [], start=1):
        guid = _text(_pick(item.get("Guid"), item.get("workforce_guid")))
        if guid is None:
            continue
        key = (snapshot.snapshot_id, area.area_pk, guid)
        if session.get(AreaWorkforceObservation, key) is not None:
            continue
        session.add(
            AreaWorkforceObservation(
                snapshot_id=snapshot.snapshot_id,
                area_pk=area.area_pk,
                workforce_guid=guid,
                scope_kind="current_camera_area",
                ordinal=_int(_pick(item.get("ordinal"), item.get("index"))) or index,
                localized_name=_text(_pick(item.get("Text"), item.get("name"))),
                population_count=_float(item.get("population_count")),
                resulting_from_population=_float(item.get("resulting_from_population")),
                registered_production=_float(item.get("registered_production")),
                registered_consumption=_float(item.get("registered_consumption")),
                delta_without_buffs=_float(item.get("delta_without_buffs")),
                delta_with_buffs=_float(item.get("delta_with_buffs")),
            )
        )


def _normalise_participant(session: Session, snapshot: SnapshotBatch, data: dict) -> None:
    finance = data.get("finance") or {}
    money = finance.get("money") or {}
    participant = _text(_pick(finance.get("participant_guid"), snapshot.participant_guid)) or "unknown"
    key = (snapshot.snapshot_id, participant)
    observed = session.get(ParticipantFinanceObservation, key)
    if observed is None:
        observed = ParticipantFinanceObservation(
            snapshot_id=snapshot.snapshot_id,
            participant_guid=participant,
        )
        session.add(observed)
    observed.treasury = _float(finance.get("treasury"))
    observed.total_balance_raw = _float(money.get("TotalIncome"))
    observed.trade_balance_period_raw = _float(money.get("TradeBalance"))
    observed.passive_trade_balance_period_raw = _float(money.get("PassiveTradeBalance"))
    observed.active_trade_balance_period_raw = _float(money.get("ActiveTradeBalance"))
    session.flush()

    for index, category in enumerate(finance.get("categories") or [], start=1):
        kind = _text(category.get("kind")) or "unknown"
        ordinal = _int(category.get("ordinal")) or index
        category_key = (snapshot.snapshot_id, participant, kind, ordinal)
        if session.get(FinanceCategoryObservation, category_key) is not None:
            continue
        session.add(
            FinanceCategoryObservation(
                snapshot_id=snapshot.snapshot_id,
                participant_guid=participant,
                kind=kind,
                ordinal=ordinal,
                category_guid_raw=_text(category.get("Guid")),
                localized_label=_text(category.get("Text")),
                value=_float(_pick(category.get("ValueAsFloat"), category.get("value"))),
            )
        )

    flags_to_code = {
        "NotEnoughStationsActive": "not_enough_stations",
        "NoGoodsActive": "no_goods",
        "NoShipsActive": "no_ships",
        "AllShipsPausedActive": "all_ships_paused",
    }
    engine_error_codes = {
        0: "not_enough_slots",
        1: "not_enough_stations",
        2: "island_under_siege",
        3: "no_valid_pier",
        4: "no_trade_rights",
        5: "configured_good_not_traded",
        6: "loaded_good_never_unloaded",
        7: "unloaded_good_never_loaded",
        8: "goods_dont_match",
        9: "storage_full",
        10: "storage_empty",
        11: "no_goods",
        12: "no_ships",
        13: "all_ships_paused",
        14: "long_waiting_time",
        15: "mismatching_good",
        16: "goods_dropped",
    }
    routes = (data.get("route_issues") or {}).get("items") or []
    for index, route in enumerate(routes, start=1):
        active_codes = [code for field, code in flags_to_code.items() if route.get(field) is True]
        active_codes.extend(
            engine_error_codes.get(_int(value), f"engine_error_{value}")
            for value in route.get("active_error_types") or []
        )
        if not active_codes:
            active_codes = ["unspecified_issue"]
        for code in dict.fromkeys(active_codes):
            key = (snapshot.snapshot_id, _int(route.get("ordinal")) or index, code)
            if session.get(TradeRouteIssueObservation, key) is not None:
                continue
            severe = code in {
                "no_ships", "not_enough_stations", "no_valid_pier", "no_trade_rights",
            }
            session.add(
                TradeRouteIssueObservation(
                    snapshot_id=snapshot.snapshot_id,
                    ordinal=key[1],
                    route_name=_text(_pick(route.get("Name"), route.get("route_name"))),
                    issue_code=code,
                    severity="critical" if severe else "warning",
                    active_error_count=_int(route.get("ActiveErrorCount")),
                    raw_flags_json=json.dumps(route, ensure_ascii=False, sort_keys=True),
                )
            )

    route_ships = data.get("route_ships") or {}
    for item in route_ships.get("items") or []:
        ship_id = _text(_pick(item.get("ship_id"), item.get("ID")))
        route_name = _text(_pick(item.get("route_name"), item.get("RouteName")))
        if ship_id is None or not route_name:
            continue
        key = (snapshot.snapshot_id, ship_id)
        if session.get(TradeRouteShipObservation, key) is not None:
            continue
        session.add(TradeRouteShipObservation(
            snapshot_id=snapshot.snapshot_id,
            ship_id_raw=ship_id,
            route_name=route_name,
            ship_guid=_text(_pick(item.get("ship_guid"), item.get("GUID"))),
            owner_guid=_text(_pick(item.get("owner_guid"), item.get("Owner"))),
            game_session_guid=_text(_pick(item.get("game_session_guid"), item.get("SessionGuid"))),
            area_id_raw=_text(item.get("area_id")),
            is_paused=_bool(_pick(item.get("is_paused"), item.get("IsPaused"))),
            on_regular_route=_bool(_pick(item.get("on_regular_route"), item.get("OnRegularRoute"))),
            loading_speed_factor=_float(_pick(item.get("loading_speed_factor"), item.get("LoadingSpeedFactor"))),
        ))


def _production_event(session: Session, raw: TelemetryRaw, envelope: dict) -> NormalizationResult:
    event_type = _text(envelope.get("event_type")) or "unknown"
    data = envelope.get("data") or {}
    if event_type == "telemetry_loaded":
        _open_play_session(session, raw, envelope)
        return NormalizationResult()
    if event_type == "telemetry_unloaded":
        play = _find_play_session(session, raw, envelope)
        if play is not None:
            play.is_current = False
            play.ended_at = raw.received_at
            raw.play_session_id = play.play_session_id
        return NormalizationResult()
    if not event_type.startswith(("snapshot_", "participant_", "area_")):
        return NormalizationResult()

    play, snapshot = _snapshot_for_event(session, raw, envelope)
    if event_type == "snapshot_started":
        context = data.get("context") or {}
        campaign = _ensure_campaign(session, play, context)
        snapshot.play_time = _int(context.get("play_time"))
        snapshot.corporation_time = _int(context.get("corporation_time"))
        snapshot.current_game_session_guid = _text(context.get("game_session_guid"))
        snapshot.current_region_guid = _text(context.get("region_guid"))
        snapshot.current_area_id_raw = _text(context.get("current_area_id"))
        snapshot.participant_guid = _text(context.get("participant_guid"))
        snapshot.area_enumeration_scope = _text(data.get("area_enumeration_scope")) or "unknown"
        snapshot.expected_area_count = _int(data.get("area_count")) or 0
        snapshot.section_mode = _text(data.get("section_mode")) or "full"
        snapshot.catalog_hash = _text(envelope.get("catalog_hash"))
        if play.initial_play_time is None:
            play.initial_play_time = snapshot.play_time
            play.initial_corporation_time = snapshot.corporation_time
        play.last_play_time = snapshot.play_time
        play.last_corporation_time = snapshot.corporation_time
        _section_status(
            session,
            snapshot,
            "context",
            "success" if envelope.get("ok", True) else "failed",
            reported_count=snapshot.expected_area_count,
            captured_count=_int(data.get("captured_area_count")),
            truncated=_bool(data.get("areas_truncated")),
            errors=data.get("section_errors"),
        )
        return NormalizationResult()

    if play.campaign_id is None:
        _ensure_campaign(session, play, {})
    campaign = session.get(Campaign, play.campaign_id)
    if campaign is None:
        raise RuntimeError("play session has no campaign")

    if event_type == "participant_snapshot":
        _normalise_participant(session, snapshot, data)
        _section_status(
            session,
            snapshot,
            "participant",
            "success" if envelope.get("ok", True) else "failed",
            errors=data.get("section_errors"),
        )
        route_ships = data.get("route_ships") or {}
        route_status = _text(route_ships.get("status")) or "not_observed"
        if route_status not in {"success", "failed", "not_observed"}:
            route_status = "not_observed"
        _section_status(
            session,
            snapshot,
            "active_routes",
            route_status,
            reported_count=_int(route_ships.get("reported_count")),
            captured_count=_int(route_ships.get("assigned_count")),
            truncated=_bool(route_ships.get("truncated")),
            errors=route_ships.get("errors") or route_ships.get("error"),
        )
    elif event_type in {"area_snapshot", "area_core"}:
        if not data.get("area_id") and not data.get("ID"):
            _section_status(session, snapshot, "area", "failed", errors=envelope.get("error"))
            return NormalizationResult()
        area, _ = _upsert_area_snapshot(session, snapshot, campaign, data)
        if event_type == "area_snapshot":
            _normalise_products(session, snapshot, area, data.get("products") or [])
        _normalise_population(session, snapshot, area, data.get("population") or {})
        if data.get("workforce"):
            _normalise_workforce(session, snapshot, area, data["workforce"])
        _normalise_location(session, area, data, snapshot.received_at)
        _section_status(
            session,
            snapshot,
            "area" if event_type == "area_snapshot" else "area_core",
            "success" if envelope.get("ok", True) else "failed",
            area_id=area.area_id_raw,
            errors=data.get("section_errors") or data.get("workforce_errors"),
        )
    elif event_type == "area_inventory_chunk":
        area_id = _text(data.get("area_id"))
        area = session.scalar(select(Area).where(Area.campaign_id == campaign.campaign_id, Area.area_id_raw == area_id))
        if area is None or session.get(AreaSnapshot, (snapshot.snapshot_id, area.area_pk)) is None:
            _section_status(session, snapshot, f"inventory_chunk:{_int(data.get('chunk_index')) or 0}", "failed", area_id=area_id, errors="area core missing")
            return NormalizationResult()
        _normalise_products(session, snapshot, area, data.get("products") or [])
        _section_status(
            session, snapshot, f"inventory_chunk:{_int(data.get('chunk_index')) or 0}",
            "success" if envelope.get("ok", True) else "failed", area_id=area_id,
            reported_count=_int(data.get("attempted_count")), captured_count=len(data.get("products") or []),
            errors=data.get("errors"),
        )
    elif event_type == "area_building_chunk":
        area_id = _text(data.get("area_id"))
        area = session.scalar(select(Area).where(Area.campaign_id == campaign.campaign_id, Area.area_id_raw == area_id))
        if area is None or session.get(AreaSnapshot, (snapshot.snapshot_id, area.area_pk)) is None:
            _section_status(session, snapshot, f"building_chunk:{_int(data.get('chunk_index')) or 0}", "failed", area_id=area_id, errors="area core missing")
            return NormalizationResult()
        for item in data.get("buildings") or []:
            guid = _text(item.get("building_guid"))
            count = _int(item.get("count"))
            if guid is None or count is None:
                continue
            if session.get(AreaBuildingObservation, (snapshot.snapshot_id, area.area_pk, guid)) is None:
                session.add(AreaBuildingObservation(snapshot_id=snapshot.snapshot_id, area_pk=area.area_pk, building_guid=guid, building_count=count))
        _section_status(
            session, snapshot, f"building_chunk:{_int(data.get('chunk_index')) or 0}",
            "success" if envelope.get("ok", True) else "failed", area_id=area_id,
            reported_count=_int(data.get("attempted_count")), captured_count=len(data.get("buildings") or []),
            errors=data.get("errors"),
        )
    elif event_type == "area_completed":
        area_id = _text(data.get("area_id"))
        for section_name in ("inventory", "buildings"):
            section = data.get(section_name) or {}
            declared_status = _text(section.get("status")) or "not_observed"
            expected_chunks = _int(section.get("chunk_count"))
            chunk_prefix = "inventory_chunk:" if section_name == "inventory" else "building_chunk:"
            observed_chunks = session.scalar(
                select(func.count()).select_from(SnapshotSectionStatus).where(
                    SnapshotSectionStatus.snapshot_id == snapshot.snapshot_id,
                    SnapshotSectionStatus.area_id_raw == area_id,
                    SnapshotSectionStatus.section_name.like(f"{chunk_prefix}%"),
                )
            ) or 0
            failed_chunks = session.scalar(
                select(func.count()).select_from(SnapshotSectionStatus).where(
                    SnapshotSectionStatus.snapshot_id == snapshot.snapshot_id,
                    SnapshotSectionStatus.area_id_raw == area_id,
                    SnapshotSectionStatus.section_name.like(f"{chunk_prefix}%"),
                    SnapshotSectionStatus.status == "failed",
                )
            ) or 0
            chunk_error = None
            if expected_chunks is not None and observed_chunks != expected_chunks:
                declared_status = "failed"
                chunk_error = {
                    "error": "missing or duplicate snapshot chunks",
                    "expected_chunks": expected_chunks,
                    "observed_chunks": observed_chunks,
                }
            elif failed_chunks:
                declared_status = "failed"
                chunk_error = {"error": "one or more chunks failed", "failed_chunks": failed_chunks}
            _section_status(
                session, snapshot, section_name,
                declared_status, area_id=area_id,
                reported_count=_int(section.get("attempted_count")),
                captured_count=_int(section.get("captured_count")),
                truncated=_bool(section.get("truncated")), errors=chunk_error or section.get("errors"),
            )
    elif event_type == "snapshot_completed":
        session.flush()
        actual = session.scalar(
            select(func.count()).select_from(AreaSnapshot).where(AreaSnapshot.snapshot_id == snapshot.snapshot_id)
        ) or 0
        snapshot.emitted_area_count = actual
        declared_complete = bool(data.get("complete")) and envelope.get("ok", True) is not False
        failed_sections = session.scalar(
            select(func.count()).select_from(SnapshotSectionStatus).where(
                SnapshotSectionStatus.snapshot_id == snapshot.snapshot_id,
                SnapshotSectionStatus.status == "failed",
            )
        ) or 0
        snapshot.is_complete = declared_complete and actual == snapshot.expected_area_count and failed_sections == 0
        snapshot.completed_at = raw.received_at
        snapshot.normalization_status = "complete" if snapshot.is_complete else "partial"
        _section_status(
            session,
            snapshot,
            "batch",
            "success" if snapshot.is_complete else "failed",
            reported_count=snapshot.expected_area_count,
            captured_count=actual,
            truncated=actual < snapshot.expected_area_count,
            errors=None if snapshot.is_complete else data,
        )
        if snapshot.is_complete:
            _materialize_current_state(session, play, snapshot)
        return NormalizationResult(snapshot.snapshot_id if snapshot.is_complete else None)
    return NormalizationResult()


def _legacy_event(session: Session, raw: TelemetryRaw, envelope: dict) -> NormalizationResult:
    event_type = _text(envelope.get("event_type")) or "unknown"
    data = envelope.get("data") or {}
    if event_type == "scope_probe_loaded":
        _open_play_session(session, raw, envelope)
        return NormalizationResult()
    if event_type == "scope_probe_unloaded":
        return NormalizationResult()
    if not event_type.startswith("scope_") or _int(envelope.get("sample_number")) in {None, 0}:
        return NormalizationResult()

    play, snapshot = _snapshot_for_event(session, raw, envelope)
    if event_type == "scope_context":
        campaign = _ensure_campaign(session, play, data)
        clocks = data.get("clocks") or {}
        snapshot.play_time = _int((clocks.get("play_time") or {}).get("value"))
        snapshot.corporation_time = _int((clocks.get("corporation_time") or {}).get("value"))
        snapshot.current_game_session_guid = _text((data.get("session") or {}).get("SessionGUID"))
        snapshot.current_region_guid = _text((data.get("session") or {}).get("RegionGUID"))
        current = data.get("current_area") or {}
        snapshot.current_area_id_raw = _text(_pick(current.get("id_string"), current.get("ID"))) if current.get("is_valid") else None
        snapshot.participant_guid = _text((data.get("participant") or {}).get("GetCurrentParticipantGUID"))
        controlled = data.get("controlled_areas") or {}
        snapshot.area_enumeration_scope = "all_controlled_areas"
        snapshot.expected_area_count = _int(controlled.get("reported_count")) or 0
        for area_data in controlled.get("areas") or []:
            _upsert_area_snapshot(session, snapshot, campaign, area_data)
        _section_status(
            session,
            snapshot,
            "legacy_context",
            "success" if envelope.get("ok", True) else "failed",
            reported_count=snapshot.expected_area_count,
            captured_count=_int(controlled.get("captured_count")),
            truncated=_bool(controlled.get("truncated")),
        )
    elif play.campaign_id is not None and event_type == "scope_target_economy":
        campaign = session.get(Campaign, play.campaign_id)
        target = data.get("target_area") or {}
        if campaign is not None and (target.get("id_string") or target.get("ID")):
            area, _ = _upsert_area_snapshot(session, snapshot, campaign, target)
            _normalise_products(session, snapshot, area, data.get("products") or [])
            _section_status(session, snapshot, "legacy_target_economy", "success", area_id=area.area_id_raw)
    elif play.campaign_id is not None and event_type == "scope_workforce":
        if snapshot.current_area_id_raw:
            area = session.scalar(
                select(Area).where(
                    Area.campaign_id == play.campaign_id,
                    Area.area_id_raw == snapshot.current_area_id_raw,
                )
            )
            if area is not None and session.get(AreaSnapshot, (snapshot.snapshot_id, area.area_pk)) is not None:
                _normalise_workforce(session, snapshot, area, data)
        _section_status(
            session,
            snapshot,
            "legacy_workforce",
            "success" if envelope.get("ok", True) else "not_observed",
            errors=data.get("section_errors"),
        )
    elif event_type == "scope_statistics":
        _section_status(session, snapshot, "legacy_ui_statistics_raw_only", "not_normalized")
    elif event_type == "scope_history":
        _section_status(session, snapshot, "legacy_ui_history_raw_only", "not_normalized")
    elif event_type == "scope_sample_finished":
        snapshot.emitted_area_count = session.scalar(
            select(func.count()).select_from(AreaSnapshot).where(AreaSnapshot.snapshot_id == snapshot.snapshot_id)
        ) or 0
        snapshot.completed_at = raw.received_at
        snapshot.is_complete = False
        snapshot.normalization_status = "legacy_partial"
    return NormalizationResult()


def normalize_raw(session: Session, raw: TelemetryRaw, envelope: dict) -> NormalizationResult:
    result = (
        _production_event(session, raw, envelope)
        if raw.source_kind == "production"
        else _legacy_event(session, raw, envelope)
    )
    raw.parse_status = "normalized"
    return result
