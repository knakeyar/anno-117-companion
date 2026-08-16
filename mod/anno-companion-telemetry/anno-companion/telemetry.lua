local Telemetry = {}
local json = require("json")
local catalog = require("catalog")

local VERSION = "1.0.0"
local SCHEMA_VERSION = 1
local PREFIX = "ANNO_COMPANION_TELEMETRY_JSON "

local CONFIG = {
    delay_ticks_after_load = 30,
    sample_interval_ms = 30000,
    max_areas = 64,
    max_population_levels = 16,
    max_workforces = 16,
    max_finance_categories = 32,
    max_issue_routes = 32,
}

local state = {
    initialized = false,
    loaded = false,
    ready = false,
    sampling = false,
    delay_ticks_remaining = nil,
    load_epoch = 0,
    sequence = 0,
    snapshot_sequence = 0,
    last_snapshot_play_time = nil,
    last_observed_play_time = nil,
}

local function safe_value(value)
    if value == nil then
        return nil
    end
    local value_type = type(value)
    if value_type == "string" or value_type == "number" or value_type == "boolean" then
        return value
    end
    local ok, rendered = pcall(function() return tostring(value) end)
    return ok and rendered or ("<unprintable " .. value_type .. ">")
end

local function safe_get(object, field_name)
    if object == nil then
        return false, nil, "parent object is nil"
    end
    local ok, value = pcall(function() return object[field_name] end)
    if not ok then
        return false, nil, tostring(value)
    end
    return true, value, nil
end

local function raw_log(line)
    local logged = false
    if system ~= nil and type(system.logInfo) == "function" then
        logged = pcall(function() system.logInfo(line) end)
    end
    if not logged and system ~= nil and type(system.log) == "function" then
        logged = pcall(function() system.log(line) end)
    end
    if not logged then
        pcall(function() print(line) end)
    end
end

local function emit(event_type, data, snapshot_sequence, ok, error_message)
    state.sequence = state.sequence + 1
    local envelope = {
        schema_version = SCHEMA_VERSION,
        mod_version = VERSION,
        catalog_release = catalog.release_id,
        catalog_hash = catalog.source_hash,
        event_type = event_type,
        sequence = state.sequence,
        load_epoch = state.load_epoch,
        snapshot_sequence = snapshot_sequence,
        ok = ok ~= false,
        data = data or {},
    }
    if error_message ~= nil then
        envelope.error = tostring(error_message)
    end

    local encoded_ok, encoded = pcall(function() return json.encode(envelope) end)
    if encoded_ok then
        raw_log(PREFIX .. encoded)
    else
        raw_log(PREFIX .. "{\"schema_version\":1,\"event_type\":\"encoder_error\",\"ok\":false}")
        raw_log("Anno Companion telemetry encoder error: " .. tostring(encoded))
    end
end

local function add_error(errors, name, failure)
    errors[name] = tostring(failure or "unknown error")
end

local function call_into(result, errors, name, callback)
    local ok, value = pcall(callback)
    if ok then
        result[name] = safe_value(value)
    else
        add_error(errors, name, value)
    end
    return ok, value
end

local function capture_fields(object, field_names)
    local result = {}
    local errors = {}
    for _, name in ipairs(field_names) do
        local ok, value, failure = safe_get(object, name)
        if ok then
            result[name] = safe_value(value)
        else
            add_error(errors, name, failure)
        end
    end
    if next(errors) ~= nil then
        result.read_errors = errors
    end
    return result
end

local function read_collection(collection, limit)
    if collection == nil then
        return nil, "collection is nil"
    end
    local result = { items = {}, reported_count = 0, captured_count = 0, truncated = false }
    local ok, failure = pcall(function()
        result.reported_count = #collection
        result.captured_count = math.min(result.reported_count, limit)
        result.truncated = result.reported_count > limit
        for index = 1, result.captured_count do
            result.items[index] = collection[index]
        end
    end)
    return ok and result or nil, ok and nil or tostring(failure)
end

local function area_id(area)
    local ok, value = safe_get(area, "ID")
    return ok and value or nil
end

local function current_play_time()
    local ok, value = safe_get(GameClock, "PlayTime")
    return ok and type(value) == "number" and value or nil
end

local function capture_offer(controller, product_guid, errors)
    local trade = {}
    call_into(trade, errors, "minimum_stock", function()
        return controller:GetMinimumStockForProductOrBulk(product_guid)
    end)
    local offer_ok, offer = pcall(function()
        return controller:GetOfferOrBulkOffer(product_guid)
    end)
    if offer_ok and offer ~= nil then
        trade.offer = capture_fields(offer, {
            "IsSellOnly", "IsBuyOnly", "IsBuyOrSell", "IsNoOffer", "IsPreferedGood",
        })
    else
        add_error(errors, "offer", offer)
    end
    return trade
end

local function capture_population(area_raw_id, errors)
    local result = { levels = {} }
    local manager_ok, manager = pcall(function() return GetAreaManagerByID(area_raw_id) end)
    if not manager_ok or manager == nil then
        add_error(errors, "area_manager", manager)
        return result, nil
    end

    local population_ok, population, population_error = safe_get(manager, "AreaPopulation")
    if population_ok and population ~= nil then
        result.summary = capture_fields(population, {
            "PopulationCount", "AmountOfResidences", "CityStatus", "CityStatusName", "CityStatusLevel",
        })
        local levels_ok, levels, levels_error = safe_get(population, "PopulationLevels")
        if levels_ok and levels ~= nil then
            local values, collection_error = read_collection(levels, CONFIG.max_population_levels)
            if values ~= nil then
                result.reported_count = values.reported_count
                result.captured_count = values.captured_count
                result.truncated = values.truncated
                for index, level in ipairs(values.items) do
                    local item = capture_fields(level, { "Guid", "Text", "Icon", "Workforce" })
                    item.ordinal = index
                    local guid_ok, guid = safe_get(level, "Guid")
                    if guid_ok and guid ~= nil then
                        local item_errors = {}
                        call_into(item, item_errors, "population_count", function()
                            return population:GetPopulationCount(guid)
                        end)
                        call_into(item, item_errors, "satisfaction", function()
                            return population:GetSatisfaction(guid)
                        end)
                        if next(item_errors) ~= nil then item.read_errors = item_errors end
                    end
                    result.levels[#result.levels + 1] = item
                end
            else
                add_error(errors, "population_levels", collection_error)
            end
        else
            add_error(errors, "population_levels", levels_error)
        end
    else
        add_error(errors, "population", population_error)
    end

    local money_ok, area_money, money_error = safe_get(manager, "AreaMoney")
    if money_ok and area_money ~= nil then
        result.area_money = capture_fields(area_money, { "TotalMoneyIncome", "LandTax" })
    else
        add_error(errors, "area_money", money_error)
    end
    return result, manager
end

local function capture_workforce(current_area_id, errors)
    if current_area_id == nil then
        add_error(errors, "scope", "current camera area is invalid")
        return nil
    end
    local list_ok, workforces, list_error = safe_get(AreaWorkforce, "Workforces")
    if not list_ok or workforces == nil then
        add_error(errors, "workforces", list_error)
        return nil
    end
    local values, collection_error = read_collection(workforces, CONFIG.max_workforces)
    if values == nil then
        add_error(errors, "workforces", collection_error)
        return nil
    end
    local result = {
        scope = "current_camera_area",
        area_id = tostring(current_area_id),
        reported_count = values.reported_count,
        captured_count = values.captured_count,
        truncated = values.truncated,
        items = {},
    }
    for index, workforce in ipairs(values.items) do
        local item = capture_fields(workforce, { "Guid", "Text" })
        item.ordinal = index
        local guid_ok, guid = safe_get(workforce, "Guid")
        local item_errors = {}
        if guid_ok and guid ~= nil then
            call_into(item, item_errors, "population_count", function()
                return AreaWorkforce:GetPopulationCount(guid)
            end)
            call_into(item, item_errors, "resulting_from_population", function()
                return AreaWorkforce:GetWorkforceResultingFromPopulation(guid)
            end)
            call_into(item, item_errors, "registered_production", function()
                return AreaWorkforce:RegisteredDeltaProduction(guid)
            end)
            call_into(item, item_errors, "registered_consumption", function()
                return AreaWorkforce:RegisteredDeltaConsumption(guid)
            end)
            call_into(item, item_errors, "delta_without_buffs", function()
                return AreaWorkforce:Delta(guid, false)
            end)
            call_into(item, item_errors, "delta_with_buffs", function()
                return AreaWorkforce:Delta(guid, true)
            end)
        else
            add_error(item_errors, "Guid", "unreadable workforce GUID")
        end
        if next(item_errors) ~= nil then item.read_errors = item_errors end
        result.items[#result.items + 1] = item
    end
    return result
end

local function capture_finance(errors)
    local result = {
        participant_guid = capture_fields(Participants, { "GetCurrentParticipantGUID" }).GetCurrentParticipantGUID,
        money = capture_fields(Money, {
            "TotalIncome", "TradeBalance", "PassiveTradeBalance", "ActiveTradeBalance",
        }),
        categories = {},
    }

    local meta_ok, meta_storage, meta_error = safe_get(Economy, "MetaStorage")
    if meta_ok and meta_storage ~= nil then
        call_into(result, errors, "treasury", function()
            return meta_storage:GetStorageAmount(1010017)
        end)
    else
        add_error(errors, "treasury", meta_error)
    end

    local function add_categories(kind, collection)
        local values, failure = read_collection(collection, CONFIG.max_finance_categories)
        if values == nil then
            add_error(errors, kind .. "_categories", failure)
            return
        end
        for index, entry in ipairs(values.items) do
            local captured = capture_fields(entry, { "Guid", "Text", "ValueAsFloat" })
            captured.kind = kind
            captured.ordinal = index
            result.categories[#result.categories + 1] = captured
        end
    end

    local positive_ok, positive, positive_error = safe_get(Money, "PositiveMoneyPerCategory")
    if positive_ok and positive ~= nil then add_categories("positive", positive)
    else add_error(errors, "positive_categories", positive_error) end
    local negative_ok, negative, negative_error = safe_get(Money, "NegativeMoneyPerCategory")
    if negative_ok and negative ~= nil then add_categories("negative", negative)
    else add_error(errors, "negative_categories", negative_error) end
    return result
end

local function capture_route_issues(errors)
    local list_ok, routes, list_error = safe_get(TradeRoute, "TradeRoutesWithIssues")
    if not list_ok or routes == nil then
        add_error(errors, "route_issues", list_error)
        return { items = {} }
    end
    local values, collection_error = read_collection(routes, CONFIG.max_issue_routes)
    if values == nil then
        add_error(errors, "route_issues", collection_error)
        return { items = {} }
    end
    local result = {
        reported_count = values.reported_count,
        captured_count = values.captured_count,
        truncated = values.truncated,
        items = {},
    }
    for index, route in ipairs(values.items) do
        local item = capture_fields(route, {
            "Name", "NotEnoughStationsActive", "NoGoodsActive", "NoShipsActive",
            "AllShipsPausedActive", "ActiveErrorCount",
        })
        item.ordinal = index
        item.active_error_types = {}
        for error_type = 0, 16 do
            local error_ok, active = pcall(function() return route:IsErrorActive(error_type) end)
            if error_ok and active then item.active_error_types[#item.active_error_types + 1] = error_type end
        end
        result.items[#result.items + 1] = item
    end
    return result
end

local function build_area(area, current_area_id)
    local result = capture_fields(area, {
        "ID", "CityName", "Owner", "OwnerName", "IsOwnedByCurrentParticipant", "HasAreaEconomy",
    })
    local errors = {}
    local raw_id = area_id(area)
    if raw_id == nil then
        add_error(errors, "ID", "area ID is unavailable")
        result.section_errors = errors
        return result
    end
    result.area_id = tostring(raw_id)
    result.is_current_area = current_area_id ~= nil and tostring(raw_id) == tostring(current_area_id)
    result.products = {}

    local economy_ok, economy, economy_error = safe_get(area, "Economy")
    local trade_ok, passive_trade, trade_error = safe_get(area, "PassiveTrade")
    if not economy_ok or economy == nil then add_error(errors, "economy", economy_error) end
    if not trade_ok or passive_trade == nil then add_error(errors, "passive_trade", trade_error) end

    for _, product in ipairs(catalog.products) do
        local item = { product_guid = tostring(product.guid) }
        local item_errors = {}
        if economy ~= nil then
            call_into(item, item_errors, "stock", function() return economy:GetStorageAmount(product.guid) end)
            call_into(item, item_errors, "available", function() return economy:GetAvailableAmount(product.guid) end)
            call_into(item, item_errors, "capacity", function() return economy:GetStorageCapacity(product.guid) end)
            call_into(item, item_errors, "reserved", function() return economy:GetReservedStorageAmount(product.guid) end)
            call_into(item, item_errors, "free_space_raw", function() return economy:GetFreeSpace(product.guid) end)
            call_into(item, item_errors, "engine_trend_raw", function() return economy:GetStorageTrend(product.guid) end)
        end
        if passive_trade ~= nil then
            item.passive_trade = capture_offer(passive_trade, product.guid, item_errors)
        end
        if next(item_errors) ~= nil then item.read_errors = item_errors end
        result.products[#result.products + 1] = item
    end

    local population = capture_population(raw_id, errors)
    result.population = population
    if result.is_current_area then
        local workforce_errors = {}
        result.workforce = capture_workforce(raw_id, workforce_errors)
        if next(workforce_errors) ~= nil then result.workforce_errors = workforce_errors end
    end
    if next(errors) ~= nil then result.section_errors = errors end
    return result
end

local function get_identity_context()
    local setup_ok, setup = safe_get(GameSetup, "CurrentGameSetup")
    local current_ok, current_area = safe_get(Area, "Current")
    local current_area_id = current_ok and area_id(current_area) or nil
    local context = {
        participant_guid = safe_value(capture_fields(Participants, { "GetCurrentParticipantGUID" }).GetCurrentParticipantGUID),
        game_session_guid = safe_value(capture_fields(GameSession, { "SessionGUID" }).SessionGUID),
        region_guid = safe_value(capture_fields(GameSession, { "RegionGUID" }).RegionGUID),
        current_area_id = current_area_id ~= nil and tostring(current_area_id) or nil,
        play_time = safe_value(capture_fields(GameClock, { "PlayTime" }).PlayTime),
        corporation_time = safe_value(capture_fields(GameClock, { "CorporationTime" }).CorporationTime),
        game_speed = safe_value(capture_fields(GameClock, { "GameSpeed" }).GameSpeed),
    }
    if setup_ok and setup ~= nil then
        local game_setup = capture_fields(setup, { "GameSeed", "DifficultyLevel", "IsCampaignEnabled" })
        context.game_seed = safe_value(game_setup.GameSeed)
        context.difficulty_level = safe_value(game_setup.DifficultyLevel)
    end
    return context, current_area_id
end

function Telemetry:Sample(trigger)
    if not state.loaded or not state.ready or state.sampling then return end
    state.sampling = true
    state.snapshot_sequence = state.snapshot_sequence + 1
    local snapshot = state.snapshot_sequence
    local context, current_area_id = get_identity_context()

    local list_ok, controlled_areas, list_error = safe_get(Participants, "ControlledAreaList")
    local areas, collection_error = nil, nil
    if list_ok and controlled_areas ~= nil then
        areas, collection_error = read_collection(controlled_areas, CONFIG.max_areas)
    end
    local area_count = areas ~= nil and areas.reported_count or 0
    emit("snapshot_started", {
        trigger = trigger,
        context = context,
        area_enumeration_scope = "all_controlled_areas",
        area_count = area_count,
        captured_area_count = areas ~= nil and areas.captured_count or 0,
        areas_truncated = areas ~= nil and areas.truncated or false,
        section_errors = areas == nil and { controlled_areas = list_error or collection_error } or nil,
    }, snapshot, areas ~= nil, areas == nil and (list_error or collection_error) or nil)

    local participant_errors = {}
    local participant = {
        finance = capture_finance(participant_errors),
        route_issues = capture_route_issues(participant_errors),
    }
    if next(participant_errors) ~= nil then participant.section_errors = participant_errors end
    emit("participant_snapshot", participant, snapshot, next(participant_errors) == nil)

    local emitted_areas = 0
    local failed_areas = 0
    if areas ~= nil then
        for _, area in ipairs(areas.items) do
            local area_ok, result = pcall(build_area, area, current_area_id)
            if area_ok then
                emitted_areas = emitted_areas + 1
                emit("area_snapshot", result, snapshot, result.section_errors == nil)
            else
                failed_areas = failed_areas + 1
                emit("area_snapshot", {}, snapshot, false, result)
            end
        end
    end

    emit("snapshot_completed", {
        expected_area_count = area_count,
        emitted_area_count = emitted_areas,
        failed_area_count = failed_areas,
        complete = areas ~= nil and not areas.truncated and emitted_areas == area_count and failed_areas == 0,
    }, snapshot, areas ~= nil and not areas.truncated and emitted_areas == area_count and failed_areas == 0)
    state.last_snapshot_play_time = current_play_time()
    state.sampling = false
end

function Telemetry:Init()
    state.initialized = true
    emit("telemetry_initialized", {
        sample_interval_ms = CONFIG.sample_interval_ms,
        transport = "game_log",
    })
end

function Telemetry:Load()
    state.load_epoch = state.load_epoch + 1
    state.loaded = true
    state.ready = false
    state.sampling = false
    state.snapshot_sequence = 0
    state.last_snapshot_play_time = nil
    state.last_observed_play_time = nil
    state.delay_ticks_remaining = CONFIG.delay_ticks_after_load
    emit("telemetry_loaded", {
        delay_ticks_before_first_snapshot = CONFIG.delay_ticks_after_load,
        sample_interval_ms = CONFIG.sample_interval_ms,
    })
end

function Telemetry:Unload()
    emit("telemetry_unloaded", { snapshots_emitted = state.snapshot_sequence })
    state.loaded = false
    state.ready = false
    state.sampling = false
    state.delay_ticks_remaining = nil
    state.last_snapshot_play_time = nil
    state.last_observed_play_time = nil
end

function Telemetry:Tick()
    if not state.loaded then return end
    if not state.ready then
        state.delay_ticks_remaining = state.delay_ticks_remaining - 1
        if state.delay_ticks_remaining <= 0 then
            state.ready = true
            state.delay_ticks_remaining = nil
            local play_time = current_play_time()
            state.last_observed_play_time = play_time
            state.last_snapshot_play_time = play_time
        end
        return
    end
    local play_time = current_play_time()
    if play_time == nil then return end
    if state.last_observed_play_time == nil then
        state.last_observed_play_time = play_time
        state.last_snapshot_play_time = play_time
        return
    end
    if play_time <= state.last_observed_play_time then
        if play_time < state.last_observed_play_time then
            state.last_snapshot_play_time = play_time
        end
        state.last_observed_play_time = play_time
        return
    end
    state.last_observed_play_time = play_time
    if state.last_snapshot_play_time ~= nil
        and play_time - state.last_snapshot_play_time >= CONFIG.sample_interval_ms then
        self:Sample("tick_play_time_watchdog")
    end
end

return Telemetry
