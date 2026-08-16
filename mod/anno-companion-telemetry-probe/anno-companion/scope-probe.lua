local Probe = {}
local json = require("json")

local VERSION = "0.3.0"
local EVENT_GROUP = "anno-companion-telemetry-probe"

local CONFIG = {
    output_prefix = "ANNO_COMPANION_PROBE_JSON ",
    delay_ticks_after_load = 30,
    sample_interval_ms = 10000,
    watchdog_interval_ms = 12000,
    event_min_spacing_ms = 8000,
    max_samples_per_load = 24,
    product_guids = { 2174, 2176, 2178 },
    building_guids = { 2955, 2962, 2963 },
    history_indices = { 0, 1, 2, 3 },
    limits = {
        controlled_areas = 64,
        workforces = 16,
        trade_offers = 32,
    },
}

local state = {
    initialized = false,
    loaded = false,
    ready = false,
    sampling = false,
    completed = false,
    event_registered = false,
    event_registration_error = nil,
    delay_ticks_remaining = nil,
    load_epoch = 0,
    sample_number = 0,
    sequence = 0,
    last_sample_play_time = nil,
}

local function raw_log(line)
    local logged = false

    if system ~= nil and type(system.logInfo) == "function" then
        logged = pcall(function()
            system.logInfo(line)
        end)
    end

    if not logged and system ~= nil and type(system.log) == "function" then
        logged = pcall(function()
            system.log(line)
        end)
    end

    if not logged then
        pcall(function()
            print(line)
        end)
    end
end

local function emit(event_type, ok, data, error_message, trigger)
    state.sequence = state.sequence + 1

    local envelope = {
        schema_version = 0,
        probe_version = VERSION,
        event_type = event_type,
        ok = ok,
        sequence = state.sequence,
        load_epoch = state.load_epoch,
        sample_number = state.sample_number,
        data = data or {},
    }
    if error_message ~= nil then
        envelope.error = tostring(error_message)
    end
    if trigger ~= nil then
        envelope.trigger = trigger
    end

    local encoded_ok, encoded_or_error = pcall(function()
        return json.encode(envelope)
    end)
    if encoded_ok then
        raw_log(CONFIG.output_prefix .. encoded_or_error)
    else
        raw_log(CONFIG.output_prefix .. "{\"event_type\":\"probe_encoder_error\",\"ok\":false}")
        raw_log("Anno Companion probe encoder error: " .. tostring(encoded_or_error))
    end
end

local function safe_value(value)
    if value == nil then
        return nil
    end

    local value_type = type(value)
    if value_type == "string" or value_type == "number" or value_type == "boolean" then
        return value
    end

    local ok, text = pcall(function()
        return tostring(value)
    end)
    return ok and text or ("<unprintable " .. value_type .. ">")
end

local function safe_get(object, field_name)
    if object == nil then
        return false, nil, "parent object is nil"
    end

    local ok, value = pcall(function()
        return object[field_name]
    end)
    if not ok then
        return false, nil, tostring(value)
    end
    return true, value, nil
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
    local values = {}
    local errors = {}

    for _, field_name in ipairs(field_names) do
        local ok, value, failure = safe_get(object, field_name)
        if ok then
            values[field_name] = safe_value(value)
        else
            add_error(errors, field_name, failure)
        end
    end

    if next(errors) ~= nil then
        values.read_errors = errors
    end
    return values
end

local function read_collection(collection, limit)
    if collection == nil then
        return nil, "collection is nil"
    end

    local snapshot = {
        items = {},
        reported_count = 0,
        captured_count = 0,
        truncated = false,
    }

    local ok, failure = pcall(function()
        snapshot.reported_count = #collection
        snapshot.captured_count = math.min(snapshot.reported_count, limit)
        snapshot.truncated = snapshot.reported_count > limit
        for index = 1, snapshot.captured_count do
            snapshot.items[index] = collection[index]
        end
    end)

    if not ok then
        return nil, tostring(failure)
    end
    return snapshot, nil
end

local function capture_typed_scalar(object, field_name)
    local ok, value, failure = safe_get(object, field_name)
    if not ok then
        return {
            readable = false,
            lua_type = "unreadable",
            error = failure,
        }
    end

    return {
        readable = true,
        value = safe_value(value),
        string_value = tostring(value),
        lua_type = type(value),
    }
end

local function capture_area(area)
    local result = capture_fields(area, {
        "ID",
        "CityName",
        "Owner",
        "OwnerName",
        "IsOwnedByCurrentParticipant",
        "HasAreaEconomy",
    })

    local id_ok, area_id = safe_get(area, "ID")
    if id_ok and area_id ~= nil then
        result.id_string = tostring(area_id)
        result.id_lua_type = type(area_id)
    end

    local validity_ok, validity_or_error = pcall(function()
        return area:isValid()
    end)
    if validity_ok then
        result.is_valid = safe_value(validity_or_error)
    else
        result.validity_error = tostring(validity_or_error)
    end
    return result
end

local function read_controlled_areas()
    local result = {
        areas = {},
        reported_count = 0,
        captured_count = 0,
        truncated = false,
    }

    local list_ok, list, list_error = safe_get(Participants, "ControlledAreaList")
    if not list_ok or list == nil then
        result.error = list_error or "ControlledAreaList is nil"
        return false, result, {}
    end

    local collection, collection_error = read_collection(list, CONFIG.limits.controlled_areas)
    if collection == nil then
        result.error = collection_error
        return false, result, {}
    end

    result.reported_count = collection.reported_count
    result.captured_count = collection.captured_count
    result.truncated = collection.truncated

    for index, area in ipairs(collection.items) do
        local captured = capture_area(area)
        captured.index = index
        result.areas[index] = captured
    end

    return true, result, collection.items
end

local function readable_area_id(area)
    local ok, area_id = safe_get(area, "ID")
    if ok and area_id ~= nil then
        return area_id
    end
    return nil
end

local function find_controlled_area(area_objects, candidate_id)
    if candidate_id == nil then
        return nil
    end

    for _, area in ipairs(area_objects) do
        local area_id = readable_area_id(area)
        if area_id ~= nil and tostring(area_id) == tostring(candidate_id) then
            return area
        end
    end
    return nil
end

local function choose_target_area(area_objects, selected_area, current_area)
    local selected_match = find_controlled_area(area_objects, readable_area_id(selected_area))
    if selected_match ~= nil then
        return selected_match, "selected_controlled_area"
    end

    local current_match = find_controlled_area(area_objects, readable_area_id(current_area))
    if current_match ~= nil then
        return current_match, "current_controlled_area"
    end

    if #area_objects > 0 then
        return area_objects[1], "first_controlled_area_fallback"
    end
    return nil, "no_controlled_area"
end

local function get_current_and_selected_areas()
    local current_ok, current_area = safe_get(Area, "Current")
    local selected_ok, selected_area = safe_get(Area, "CurrentSelectedArea")
    return current_ok and current_area or nil, selected_ok and selected_area or nil
end

local function build_context()
    local controlled_ok, controlled, area_objects = read_controlled_areas()
    local current_area, selected_area = get_current_and_selected_areas()
    local target_area, target_reason = choose_target_area(area_objects, selected_area, current_area)

    local setup_ok, setup = safe_get(GameSetup, "CurrentGameSetup")
    local context = {
        participant = capture_fields(Participants, { "GetCurrentParticipantGUID" }),
        session = capture_fields(GameSession, {
            "SessionGUID",
            "RegionGUID",
            "IsCurrentAreaValidIsland",
        }),
        clocks = {
            corporation_time = capture_typed_scalar(GameClock, "CorporationTime"),
            play_time = capture_typed_scalar(GameClock, "PlayTime"),
            game_speed = capture_typed_scalar(GameClock, "GameSpeed"),
            time_since_saving = capture_typed_scalar(Savegame, "TimeSinceSaving"),
        },
        current_area = current_area ~= nil and capture_area(current_area) or { readable = false },
        selected_area = selected_area ~= nil and capture_area(selected_area) or { readable = false },
        controlled_areas = controlled,
        statistics_selection = capture_fields(EconomyStatistic, { "NumOfSelectedAreas" }),
        target_area_reason = target_reason,
        target_area = target_area ~= nil and capture_area(target_area) or { readable = false },
    }
    if setup_ok and setup ~= nil then
        context.game_setup = capture_fields(setup, {
            "GameSeed",
            "DifficultyLevel",
            "IsCampaignEnabled",
            "IsScenarioEnabled",
        })
    else
        context.game_setup = { readable = false }
    end

    return controlled_ok, context, target_area
end

local function capture_offer(offer)
    if offer == nil then
        return { readable = false }
    end
    local result = capture_fields(offer, {
        "IsSellOnly",
        "IsBuyOnly",
        "IsBuyOrSell",
        "IsNoOffer",
        "IsPreferedGood",
    })
    result.readable = result.read_errors == nil
    return result
end

local function capture_offer_list(collection)
    local snapshot, failure = read_collection(collection, CONFIG.limits.trade_offers)
    if snapshot == nil then
        return { items = {}, error = failure }
    end

    local result = {
        items = {},
        reported_count = snapshot.reported_count,
        captured_count = snapshot.captured_count,
        truncated = snapshot.truncated,
    }
    for index, offer in ipairs(snapshot.items) do
        local item = capture_fields(offer, { "Guid", "Price", "Amount", "EndlessAmount" })
        item.index = index
        result.items[index] = item
    end
    return result
end

local function build_target_economy(target_area)
    local result = {
        target_area = target_area ~= nil and capture_area(target_area) or { readable = false },
        products = {},
        buy_offers = { items = {} },
        sell_offers = { items = {} },
    }
    local section_errors = {}

    if target_area == nil then
        add_error(section_errors, "target_area", "no controlled target area")
        result.section_errors = section_errors
        return false, result
    end

    local economy_ok, economy, economy_error = safe_get(target_area, "Economy")
    local trade_ok, passive_trade, trade_error = safe_get(target_area, "PassiveTrade")
    if not economy_ok or economy == nil then
        add_error(section_errors, "economy", economy_error or "Economy is nil")
    end
    if not trade_ok or passive_trade == nil then
        add_error(section_errors, "passive_trade", trade_error or "PassiveTrade is nil")
    end

    for _, product_guid in ipairs(CONFIG.product_guids) do
        local product = {
            product_guid = product_guid,
            storage = {},
            passive_trade = {},
        }
        local product_errors = {}

        if economy ~= nil then
            call_into(product.storage, product_errors, "stock", function()
                return economy:GetStorageAmount(product_guid)
            end)
            call_into(product.storage, product_errors, "available", function()
                return economy:GetAvailableAmount(product_guid)
            end)
            call_into(product.storage, product_errors, "capacity", function()
                return economy:GetStorageCapacity(product_guid)
            end)
            call_into(product.storage, product_errors, "reserved", function()
                return economy:GetReservedStorageAmount(product_guid)
            end)
            call_into(product.storage, product_errors, "free_space", function()
                return economy:GetFreeSpace(product_guid)
            end)
            call_into(product.storage, product_errors, "engine_trend", function()
                return economy:GetStorageTrend(product_guid)
            end)
        end

        if passive_trade ~= nil then
            call_into(product.passive_trade, product_errors, "minimum_stock", function()
                return passive_trade:GetMinimumStockForProductOrBulk(product_guid)
            end)
            local offer_ok, offer_or_error = pcall(function()
                return passive_trade:GetOfferOrBulkOffer(product_guid)
            end)
            if offer_ok then
                product.passive_trade.offer = capture_offer(offer_or_error)
            else
                add_error(product_errors, "offer", offer_or_error)
            end
        end

        if next(product_errors) ~= nil then
            product.read_errors = product_errors
        end
        result.products[#result.products + 1] = product
    end

    if passive_trade ~= nil then
        local buy_ok, buy_offers, buy_error = safe_get(passive_trade, "BuyOffers")
        if buy_ok and buy_offers ~= nil then
            result.buy_offers = capture_offer_list(buy_offers)
        else
            add_error(section_errors, "buy_offers", buy_error or "BuyOffers is nil")
        end

        local sell_ok, sell_offers_or_error = pcall(function()
            return passive_trade:SellOffers()
        end)
        if sell_ok and sell_offers_or_error ~= nil then
            result.sell_offers = capture_offer_list(sell_offers_or_error)
        else
            add_error(section_errors, "sell_offers", sell_offers_or_error or "SellOffers is nil")
        end
    end

    if next(section_errors) ~= nil then
        result.section_errors = section_errors
    end
    return next(section_errors) == nil, result
end

local function build_statistics()
    local result = {
        selection_ready = false,
        products = {},
    }
    local section_errors = {}

    local count_ok, selected_count, count_error = safe_get(EconomyStatistic, "NumOfSelectedAreas")
    if count_ok then
        result.num_selected_areas = safe_value(selected_count)
        result.selection_ready = type(selected_count) == "number" and selected_count > 0
    else
        add_error(section_errors, "NumOfSelectedAreas", count_error)
    end

    local stats_ok, statistics, statistics_error = safe_get(EconomyStatistic, "ProductionStatistic")
    if not stats_ok or statistics == nil then
        add_error(section_errors, "ProductionStatistic", statistics_error or "ProductionStatistic is nil")
    else
        for _, product_guid in ipairs(CONFIG.product_guids) do
            local product = { product_guid = product_guid }
            local errors = {}
            call_into(product, errors, "generation_per_minute", function()
                return statistics:ProductGeneration(product_guid)
            end)
            call_into(product, errors, "consumption_per_minute", function()
                return statistics:ProductConsumption(product_guid)
            end)
            call_into(product, errors, "delta_per_minute", function()
                return statistics:ProductDelta(product_guid)
            end)
            call_into(product, errors, "perfect_generation_per_minute", function()
                return statistics:PerfectProductGeneration(product_guid)
            end)
            call_into(product, errors, "perfect_consumption_per_minute", function()
                return statistics:PerfectProductConsumption(product_guid)
            end)

            if type(product.generation_per_minute) == "number"
                and type(product.consumption_per_minute) == "number"
                and type(product.delta_per_minute) == "number" then
                product.diagnostic_delta_residual = product.delta_per_minute
                    - (product.generation_per_minute - product.consumption_per_minute)
            end

            if next(errors) ~= nil then
                product.read_errors = errors
            end
            result.products[#result.products + 1] = product
        end
    end

    if next(section_errors) ~= nil then
        result.section_errors = section_errors
    end
    return next(section_errors) == nil, result
end

local function build_history()
    local result = {
        snapshots = {},
        has_nonempty_age = false,
    }
    local section_errors = {}

    local history_ok, history, history_error = safe_get(EconomyStatistic, "History")
    if not history_ok or history == nil then
        add_error(section_errors, "History", history_error or "History is nil")
        result.section_errors = section_errors
        return false, result
    end

    for _, snapshot_index in ipairs(CONFIG.history_indices) do
        local snapshot = { snapshot_index = snapshot_index, products = {} }
        local errors = {}
        call_into(snapshot, errors, "time_since_snapshot", function()
            return history:GetTimeSinceSnapshot(snapshot_index)
        end)
        if type(snapshot.time_since_snapshot) == "string" and snapshot.time_since_snapshot ~= "" then
            result.has_nonempty_age = true
        end

        for _, product_guid in ipairs(CONFIG.product_guids) do
            local product = { product_guid = product_guid }
            local product_errors = {}
            call_into(product, product_errors, "amount", function()
                return history:GetProductAmount(snapshot_index, product_guid)
            end)
            call_into(product, product_errors, "generation", function()
                return history:GetProductGeneration(snapshot_index, product_guid)
            end)
            call_into(product, product_errors, "consumption", function()
                return history:GetProductConsumption(snapshot_index, product_guid)
            end)
            if next(product_errors) ~= nil then
                product.read_errors = product_errors
            end
            snapshot.products[#snapshot.products + 1] = product
        end

        if next(errors) ~= nil then
            snapshot.read_errors = errors
        end
        result.snapshots[#result.snapshots + 1] = snapshot
    end

    return true, result
end

local function build_workforce()
    local result = {
        workforces = {},
        reported_count = 0,
        captured_count = 0,
        truncated = false,
    }
    local section_errors = {}

    local list_ok, list, list_error = safe_get(AreaWorkforce, "Workforces")
    if not list_ok or list == nil then
        add_error(section_errors, "Workforces", list_error or "Workforces is nil")
        result.section_errors = section_errors
        return false, result
    end

    local collection, collection_error = read_collection(list, CONFIG.limits.workforces)
    if collection == nil then
        add_error(section_errors, "Workforces", collection_error)
        result.section_errors = section_errors
        return false, result
    end

    result.reported_count = collection.reported_count
    result.captured_count = collection.captured_count
    result.truncated = collection.truncated

    for index, workforce in ipairs(collection.items) do
        local item = capture_fields(workforce, { "Guid", "Text", "Value", "ValueAsFloat" })
        item.index = index
        local errors = {}
        local guid_ok, workforce_guid, guid_error = safe_get(workforce, "Guid")
        if guid_ok and workforce_guid ~= nil then
            call_into(item, errors, "delta_without_buffs", function()
                return AreaWorkforce:Delta(workforce_guid, false)
            end)
            call_into(item, errors, "delta_with_buffs", function()
                return AreaWorkforce:Delta(workforce_guid, true)
            end)
            call_into(item, errors, "population_count", function()
                return AreaWorkforce:GetPopulationCount(workforce_guid)
            end)
            call_into(item, errors, "resulting_from_population", function()
                return AreaWorkforce:GetWorkforceResultingFromPopulation(workforce_guid)
            end)
            call_into(item, errors, "registered_production", function()
                return AreaWorkforce:RegisteredDeltaProduction(workforce_guid)
            end)
            call_into(item, errors, "registered_consumption", function()
                return AreaWorkforce:RegisteredDeltaConsumption(workforce_guid)
            end)
            call_into(item, errors, "buffed_delta", function()
                return AreaWorkforce:GetBuffedDelta(workforce_guid)
            end)

            if type(item.delta_without_buffs) == "number"
                and type(item.registered_production) == "number"
                and type(item.registered_consumption) == "number" then
                item.diagnostic_balance_residual = item.delta_without_buffs
                    - (item.registered_production + item.registered_consumption)
            end
        else
            add_error(errors, "Guid", guid_error or "workforce Guid is nil")
        end

        if next(errors) ~= nil then
            item.read_errors = errors
        end
        result.workforces[#result.workforces + 1] = item
    end

    return true, result
end

local function current_play_time()
    local ok, value = safe_get(GameClock, "PlayTime")
    if ok and type(value) == "number" then
        return value
    end
    return nil
end

local function build_runtime_capabilities()
    local result = { areas = {}, building_guids = CONFIG.building_guids }
    local controlled_ok, controlled, controlled_error = safe_get(Participants, "ControlledAreaList")
    if not controlled_ok or controlled == nil then
        return false, { section_errors = { controlled_areas = tostring(controlled_error) } }
    end
    local collection, collection_error = read_collection(controlled, CONFIG.limits.controlled_areas)
    if collection == nil then return false, { section_errors = { controlled_areas = collection_error } } end
    for _, area in ipairs(collection.items) do
        local item = capture_fields(area, { "ID", "CityName", "KontorID" })
        item.position = { status = "not_observed" }
        item.building_counts = { status = "not_observed", items = {} }
        local id_ok, raw_id = safe_get(area, "ID")
        local kontor_ok, kontor_id = safe_get(area, "KontorID")
        if kontor_ok and kontor_id ~= nil then
            local object_ok, object = pcall(function() return GetGameObject.GetGameObject(kontor_id) end)
            if object_ok and object ~= nil then
                local position_ok, position = safe_get(object, "Position2D")
                local session_ok, session_guid = safe_get(object, "SessionGuid")
                if position_ok and position ~= nil then
                    local x_ok, x = safe_get(position, "x")
                    local y_ok, y = safe_get(position, "y")
                    if x_ok and y_ok then
                        item.position = { status = "success", x = safe_value(x), y = safe_value(y), session_guid = session_ok and safe_value(session_guid) or nil }
                    end
                end
            end
        end
        if id_ok and raw_id ~= nil then
            local manager_ok, manager = pcall(function() return GetAreaManagerByID(raw_id) end)
            local lists = nil
            if manager_ok and manager ~= nil then
                local objects_ok, objects = safe_get(manager, "AreaObjects")
                if objects_ok and objects ~= nil then
                    local lists_ok, value = safe_get(objects, "ObjectLists")
                    if lists_ok then lists = value end
                end
            end
            if lists ~= nil then
                item.building_counts.status = "success"
                for _, guid in ipairs(CONFIG.building_guids) do
                    local count_ok, count = pcall(function() return lists:GetBuildingsWithGameLogicCount(guid) end)
                    item.building_counts.items[#item.building_counts.items + 1] = {
                        building_guid = tostring(guid), status = count_ok and "success" or "failed",
                        count = count_ok and safe_value(count) or nil, error = count_ok and nil or tostring(count),
                    }
                end
            end
        end
        result.areas[#result.areas + 1] = item
    end
    result.region_guid = safe_value(capture_fields(GameSession, { "RegionGUID" }).RegionGUID)
    result.session_guid = safe_value(capture_fields(GameSession, { "SessionGUID" }).SessionGUID)
    return true, result
end

function Probe:Complete(reason)
    if state.completed then
        return
    end
    state.completed = true
    emit("scope_probe_completed", true, {
        reason = reason,
        samples_emitted = state.sample_number,
        expected_interval_ms = CONFIG.sample_interval_ms,
    })
end

function Probe:Sample(trigger)
    if not state.loaded or not state.ready or state.completed or state.sampling then
        return
    end
    if state.sample_number >= CONFIG.max_samples_per_load then
        self:Complete("sample_limit_reached")
        return
    end

    state.sampling = true
    state.sample_number = state.sample_number + 1
    emit("scope_sample_started", true, {
        max_samples = CONFIG.max_samples_per_load,
        expected_interval_ms = CONFIG.sample_interval_ms,
    }, nil, trigger)

    local context_call_ok, context_ok, context, target_area = pcall(build_context)
    if context_call_ok then
        emit("scope_context", context_ok, context, nil, trigger)
    else
        local context_error = context_ok
        context_ok = false
        target_area = nil
        emit("scope_context", false, nil, context_error, trigger)
    end

    local economy_call_ok, economy_ok, economy = pcall(build_target_economy, target_area)
    if economy_call_ok then
        emit("scope_target_economy", economy_ok, economy, nil, trigger)
    else
        local economy_error = economy_ok
        economy_ok = false
        emit("scope_target_economy", false, nil, economy_error, trigger)
    end

    local statistics_call_ok, statistics_ok, statistics = pcall(build_statistics)
    if statistics_call_ok then
        emit("scope_statistics", statistics_ok, statistics, nil, trigger)
    else
        local statistics_error = statistics_ok
        statistics_ok = false
        emit("scope_statistics", false, nil, statistics_error, trigger)
    end

    local workforce_call_ok, workforce_ok, workforce = pcall(build_workforce)
    if workforce_call_ok then
        emit("scope_workforce", workforce_ok, workforce, nil, trigger)
    else
        local workforce_error = workforce_ok
        workforce_ok = false
        emit("scope_workforce", false, nil, workforce_error, trigger)
    end

    local history_call_ok, history_ok, history = pcall(build_history)
    if history_call_ok then
        emit("scope_history", history_ok, history, nil, trigger)
    else
        local history_error = history_ok
        history_ok = false
        emit("scope_history", false, nil, history_error, trigger)
    end

    local runtime_call_ok, runtime_ok, runtime = pcall(build_runtime_capabilities)
    if runtime_call_ok then
        emit("scope_runtime_capabilities", runtime_ok, runtime, nil, trigger)
    else
        emit("scope_runtime_capabilities", false, nil, runtime_ok, trigger)
    end

    state.last_sample_play_time = current_play_time()
    emit("scope_sample_finished", true, {
        context_ok = context_call_ok and context_ok,
        target_economy_ok = economy_call_ok and economy_ok,
        statistics_ok = statistics_call_ok and statistics_ok,
        workforce_ok = workforce_call_ok and workforce_ok,
        history_ok = history_call_ok and history_ok,
        runtime_capabilities_ok = runtime_call_ok and runtime_ok,
    }, nil, trigger)
    state.sampling = false

    if state.sample_number >= CONFIG.max_samples_per_load then
        self:Complete("sample_limit_reached")
    end
end

function Probe:OnEvery10s()
    local play_time = current_play_time()
    if play_time ~= nil and state.last_sample_play_time ~= nil
        and play_time - state.last_sample_play_time < CONFIG.event_min_spacing_ms then
        return
    end
    self:Sample("Scripts.OnEvery10s")
end

local every_10s_listener = function()
    Probe:OnEvery10s()
end

local function register_periodic_event()
    local event_ok, event_error = pcall(function()
        Scripts.OnEvery10s:RemoveByName(EVENT_GROUP)
        Scripts.OnEvery10s:Add(every_10s_listener, EVENT_GROUP)
    end)
    state.event_registered = event_ok
    if event_ok then
        state.event_registration_error = nil
    else
        state.event_registration_error = tostring(event_error)
    end
    return event_ok
end

function Probe:Init()
    state.initialized = true
    local event_ok = register_periodic_event()

    emit("scope_probe_initialized", event_ok, {
        event_registered = state.event_registered,
        event_registration_error = state.event_registration_error or "",
        fallback = "GameClock.PlayTime watchdog via Tick",
        max_samples_per_load = CONFIG.max_samples_per_load,
        expected_interval_ms = CONFIG.sample_interval_ms,
    }, state.event_registration_error)
end

function Probe:Load()
    state.load_epoch = state.load_epoch + 1
    state.loaded = true
    state.ready = false
    state.sampling = false
    state.completed = false
    state.sample_number = 0
    state.last_sample_play_time = nil
    state.delay_ticks_remaining = CONFIG.delay_ticks_after_load
    local event_ok = register_periodic_event()

    emit("scope_probe_loaded", event_ok, {
        delay_ticks_before_first_sample = CONFIG.delay_ticks_after_load,
        event_registered = state.event_registered,
        event_registration_error = state.event_registration_error or "",
        watchdog_interval_ms = CONFIG.watchdog_interval_ms,
        instructions = "Keep the game unpaused; sample owned islands with the Production Statistics UI open.",
    }, state.event_registration_error)
end

function Probe:Unload()
    emit("scope_probe_unloaded", true, {
        samples_emitted = state.sample_number,
        completed = state.completed,
    })
    state.loaded = false
    state.ready = false
    state.sampling = false
    state.delay_ticks_remaining = nil
    state.last_sample_play_time = nil
    state.event_registered = false
end

function Probe:Tick()
    if not state.loaded or state.completed then
        return
    end

    if not state.ready then
        state.delay_ticks_remaining = state.delay_ticks_remaining - 1
        if state.delay_ticks_remaining <= 0 then
            state.ready = true
            state.delay_ticks_remaining = nil
            self:Sample("post_load")
        end
        return
    end

    local play_time = current_play_time()
    if play_time ~= nil and state.last_sample_play_time ~= nil
        and play_time - state.last_sample_play_time >= CONFIG.watchdog_interval_ms then
        self:Sample("tick_play_time_watchdog")
    end
end

return Probe
