local Telemetry = {}
local json = require("json")
local catalog = require("catalog")

local VERSION = "1.1.1"
local SCHEMA_VERSION = 2
local PREFIX = "ANNO_COMPANION_TELEMETRY_JSON "

local CONFIG = {
    delay_ticks_after_load = 30,
    sample_interval_ms = 30000,
    max_areas = 64,
    max_population_levels = 16,
    max_workforces = 16,
    max_finance_categories = 32,
    max_issue_routes = 32,
    max_route_vehicles = 128,
    product_chunk_size = 16,
    building_chunk_size = 32,
    reconciliation_interval_ms = 600000,
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
    last_full_play_time = nil,
    needs_baseline = true,
    product_state = {},
    building_state = {},
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

local function clone_nested_state(source)
    local result = {}
    for area_key, values in pairs(source) do
        result[area_key] = {}
        for guid, value in pairs(values) do result[area_key][guid] = value end
    end
    return result
end

local function region_for_session(session_guid)
    if session_guid == nil then return nil end
    for _, region in ipairs(catalog.regions or {}) do
        if tostring(region.session_guid) == tostring(session_guid) then return region.guid end
    end
    return nil
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

local function capture_route_ships()
    local result = {
        status = "not_observed",
        reported_count = nil,
        captured_count = 0,
        assigned_count = 0,
        truncated = false,
        items = {},
    }
    local errors = {}
    local property_ok, property_value, property_error = safe_get(Properties, "TradeRouteVehicle")
    if not property_ok or property_value == nil then
        result.error = tostring(property_error or "TradeRouteVehicle property unavailable")
        return result
    end
    local participant = capture_fields(Participants, { "GetCurrentParticipantGUID" }).GetCurrentParticipantGUID
    if participant == nil then
        result.error = "participant GUID unavailable"
        return result
    end
    local objects_ok, objects = pcall(function()
        return Scripts:GetObjectGroupByProperty(property_value, participant)
    end)
    if not objects_ok or objects == nil then
        result.error = tostring(objects or "trade-route vehicle enumeration unavailable")
        return result
    end
    local vehicles, collection_error = read_collection(objects, CONFIG.max_route_vehicles)
    if vehicles == nil then
        result.error = tostring(collection_error)
        return result
    end
    result.reported_count = vehicles.reported_count
    result.captured_count = vehicles.captured_count
    result.truncated = vehicles.truncated

    for vehicle_index, ship in ipairs(vehicles.items) do
        local route_ok, route_vehicle, route_error = safe_get(ship, "TradeRouteVehicle")
        if not route_ok or route_vehicle == nil then
            errors[#errors + 1] = { vehicle_index = vehicle_index, field = "TradeRouteVehicle", error = tostring(route_error) }
        else
            local assigned_ok, assigned, assigned_error = safe_get(route_vehicle, "IsAssignedOnTradeRoute")
            if not assigned_ok then
                errors[#errors + 1] = { vehicle_index = vehicle_index, field = "IsAssignedOnTradeRoute", error = tostring(assigned_error) }
            elseif assigned == true then
                local ship_fields = capture_fields(ship, { "ID", "GUID", "Owner", "SessionGuid" })
                local route_fields = capture_fields(route_vehicle, {
                    "RouteName", "IsPaused", "OnRegularRoute", "LoadingSpeedFactor",
                })
                local ship_id = ship_fields.ID
                local route_name = route_fields.RouteName
                if ship_id == nil or route_name == nil or tostring(route_name) == "" then
                    errors[#errors + 1] = {
                        vehicle_index = vehicle_index,
                        field = ship_id == nil and "ID" or "RouteName",
                        error = "assigned route ship is missing identity evidence",
                    }
                elseif ship_fields.read_errors ~= nil or route_fields.read_errors ~= nil then
                    errors[#errors + 1] = {
                        vehicle_index = vehicle_index,
                        field = "ship_fields",
                        error = "one or more assigned route ship fields were unreadable",
                    }
                else
                    local area_ok, ship_area = safe_get(ship, "Area")
                    local ship_area_id = area_ok and ship_area ~= nil and area_id(ship_area) or nil
                    result.items[#result.items + 1] = {
                        ship_id = safe_value(ship_id),
                        ship_guid = safe_value(ship_fields.GUID),
                        owner_guid = safe_value(ship_fields.Owner),
                        game_session_guid = safe_value(ship_fields.SessionGuid),
                        area_id = safe_value(ship_area_id),
                        route_name = safe_value(route_name),
                        is_paused = safe_value(route_fields.IsPaused),
                        on_regular_route = safe_value(route_fields.OnRegularRoute),
                        loading_speed_factor = safe_value(route_fields.LoadingSpeedFactor),
                    }
                end
            end
        end
    end
    result.assigned_count = #result.items
    if #errors > 0 then result.errors = errors end
    if not result.truncated and #errors == 0 then
        result.status = "success"
    elseif result.truncated then
        result.error = "route vehicle enumeration was truncated; previous route state was preserved"
    end
    return result
end

local function capture_location(area)
    local kontor_ok, kontor_id, kontor_error = safe_get(area, "KontorID")
    if not kontor_ok or kontor_id == nil then
        return { status = "not_observed", error = tostring(kontor_error or "KontorID unavailable") }
    end
    local object_ok, object = pcall(function() return GetGameObject.GetGameObject(kontor_id) end)
    if not object_ok or object == nil then
        return { status = "not_observed", kontor_id = safe_value(kontor_id), error = tostring(object or "Kontor game object unavailable") }
    end
    local position_ok, position, position_error = safe_get(object, "Position2D")
    local session_ok, session_guid = safe_get(object, "SessionGuid")
    if not session_ok then session_ok, session_guid = safe_get(object, "SessionGUID") end
    if not position_ok or position == nil then
        return { status = "not_observed", kontor_id = safe_value(kontor_id), error = tostring(position_error or "Position2D unavailable") }
    end
    local x_ok, x, x_error = safe_get(position, "x")
    local y_ok, y, y_error = safe_get(position, "y")
    if not x_ok or not y_ok then
        return { status = "not_observed", kontor_id = safe_value(kontor_id), error = tostring(x_error or y_error) }
    end
    return {
        status = "success", kontor_id = safe_value(kontor_id), x = safe_value(x), y = safe_value(y),
        session_guid = session_ok and safe_value(session_guid) or nil,
        region_guid = session_ok and safe_value(region_for_session(session_guid)) or nil,
    }
end

local function product_fingerprint(item)
    local ok, encoded = pcall(function() return json.encode(item) end)
    return ok and encoded or tostring(item.stock) .. ":" .. tostring(item.available) .. ":" .. tostring(item.capacity)
end

local function build_area(area, current_area_id, section_mode, product_state, building_state)
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
    result.location = capture_location(area)
    local products = {}
    local product_errors = {}
    local raw_key = tostring(raw_id)
    product_state[raw_key] = product_state[raw_key] or {}

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
        if next(item_errors) ~= nil then
            product_errors[#product_errors + 1] = { product_guid = tostring(product.guid), errors = item_errors }
        else
            local fingerprint = product_fingerprint(item)
            if section_mode ~= "delta" or product_state[raw_key][item.product_guid] ~= fingerprint then
                products[#products + 1] = item
            end
            product_state[raw_key][item.product_guid] = fingerprint
        end
    end

    local population = capture_population(raw_id, errors)
    result.population = population
    if result.is_current_area then
        local workforce_errors = {}
        result.workforce = capture_workforce(raw_id, workforce_errors)
        if next(workforce_errors) ~= nil then result.workforce_errors = workforce_errors end
    end
    if next(errors) ~= nil then result.section_errors = errors end
    local buildings = {}
    local building_errors = {}
    building_state[raw_key] = building_state[raw_key] or {}
    local manager_ok, manager = pcall(function() return GetAreaManagerByID(raw_id) end)
    local lists = nil
    if manager_ok and manager ~= nil then
        local area_objects_ok, area_objects = safe_get(manager, "AreaObjects")
        if area_objects_ok and area_objects ~= nil then
            local lists_ok, object_lists = safe_get(area_objects, "ObjectLists")
            if lists_ok then lists = object_lists end
        end
    end
    if lists ~= nil then
        for _, building in ipairs(catalog.buildings) do
            local count_ok, count = pcall(function() return lists:GetBuildingsWithGameLogicCount(building.guid) end)
            local guid = tostring(building.guid)
            if count_ok and type(count) == "number" then
                local previous = building_state[raw_key][guid]
                if (section_mode ~= "delta" and count > 0) or (section_mode == "delta" and previous ~= count) then
                    buildings[#buildings + 1] = { building_guid = guid, count = count }
                end
                building_state[raw_key][guid] = count
            else
                building_errors[#building_errors + 1] = { building_guid = guid, error = tostring(count) }
            end
        end
    else
        building_errors[#building_errors + 1] = { error = "AreaObjects.ObjectLists unavailable" }
    end
    return result, products, product_errors, buildings, building_errors
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

local function emit_chunks(event_type, field_name, area_raw_id, items, chunk_size, snapshot, attempted_count, errors)
    local chunk_count = math.max(1, math.ceil(#items / chunk_size), math.ceil(#errors / chunk_size))
    for chunk_index = 1, chunk_count do
        local chunk = {}
        local chunk_errors = {}
        local first = (chunk_index - 1) * chunk_size + 1
        local last = math.min(#items, chunk_index * chunk_size)
        for index = first, last do chunk[#chunk + 1] = items[index] end
        local error_last = math.min(#errors, chunk_index * chunk_size)
        for index = first, error_last do chunk_errors[#chunk_errors + 1] = errors[index] end
        local data = {
            area_id = tostring(area_raw_id), chunk_index = chunk_index, chunk_count = chunk_count,
            attempted_count = attempted_count, captured_count = #chunk,
            error_count = #chunk_errors, errors = #chunk_errors > 0 and chunk_errors or nil,
        }
        data[field_name] = chunk
        emit(event_type, data, snapshot, true)
    end
    return chunk_count
end

function Telemetry:Sample(trigger)
    if not state.loaded or not state.ready or state.sampling then return end
    state.sampling = true
    state.snapshot_sequence = state.snapshot_sequence + 1
    local snapshot = state.snapshot_sequence
    local context, current_area_id = get_identity_context()
    local play_time = current_play_time()
    local section_mode = "delta"
    if state.needs_baseline then
        section_mode = "baseline"
    elseif state.last_full_play_time == nil or play_time - state.last_full_play_time >= CONFIG.reconciliation_interval_ms then
        section_mode = "reconciliation"
    end

    local list_ok, controlled_areas, list_error = safe_get(Participants, "ControlledAreaList")
    local areas, collection_error = nil, nil
    if list_ok and controlled_areas ~= nil then
        areas, collection_error = read_collection(controlled_areas, CONFIG.max_areas)
    end
    local area_count = areas ~= nil and areas.reported_count or 0
    emit("snapshot_started", {
        trigger = trigger,
        section_mode = section_mode,
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
        route_ships = capture_route_ships(),
    }
    if next(participant_errors) ~= nil then participant.section_errors = participant_errors end
    emit("participant_snapshot", participant, snapshot, next(participant_errors) == nil)

    local emitted_areas = 0
    local failed_areas = 0
    local pending_product_state = clone_nested_state(state.product_state)
    local pending_building_state = clone_nested_state(state.building_state)
    if areas ~= nil then
        for _, area in ipairs(areas.items) do
            local area_ok, result, products, product_errors, buildings, building_errors = pcall(
                build_area, area, current_area_id, section_mode, pending_product_state, pending_building_state
            )
            if area_ok and result ~= nil and result.area_id ~= nil then
                emitted_areas = emitted_areas + 1
                local area_core_ok = result.section_errors == nil
                emit("area_core", result, snapshot, area_core_ok)
                local product_chunks = emit_chunks(
                    "area_inventory_chunk", "products", result.area_id, products, CONFIG.product_chunk_size,
                    snapshot, #catalog.products, product_errors
                )
                local building_chunks = emit_chunks(
                    "area_building_chunk", "buildings", result.area_id, buildings, CONFIG.building_chunk_size,
                    snapshot, #catalog.buildings, building_errors
                )
                emit("area_completed", {
                    area_id = result.area_id,
                    inventory = {
                        status = #product_errors == 0 and "success" or "failed",
                        mode = section_mode, attempted_count = #catalog.products, captured_count = #products,
                        error_count = #product_errors, chunk_count = product_chunks,
                    },
                    buildings = {
                        status = #building_errors == 0 and "success" or "not_observed",
                        mode = section_mode, attempted_count = #catalog.buildings, captured_count = #buildings,
                        error_count = #building_errors, chunk_count = building_chunks,
                    },
                }, snapshot, #product_errors == 0)
                if #product_errors > 0 or not area_core_ok then failed_areas = failed_areas + 1 end
            else
                failed_areas = failed_areas + 1
                emit("area_core", {}, snapshot, false, result)
            end
        end
    end

    local batch_complete = areas ~= nil and not areas.truncated and emitted_areas == area_count
        and failed_areas == 0 and next(participant_errors) == nil
    emit("snapshot_completed", {
        expected_area_count = area_count,
        emitted_area_count = emitted_areas,
        failed_area_count = failed_areas,
        participant_failed = next(participant_errors) ~= nil,
        complete = batch_complete,
    }, snapshot, batch_complete)
    if batch_complete then
        state.product_state = pending_product_state
        state.building_state = pending_building_state
        state.needs_baseline = false
        if section_mode ~= "delta" then state.last_full_play_time = play_time end
    end
    state.last_snapshot_play_time = play_time
    state.sampling = false
end

function Telemetry:Init()
    state.initialized = true
    emit("telemetry_initialized", {
        sample_interval_ms = CONFIG.sample_interval_ms,
        reconciliation_interval_ms = CONFIG.reconciliation_interval_ms,
        product_chunk_size = CONFIG.product_chunk_size,
        building_chunk_size = CONFIG.building_chunk_size,
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
    state.last_full_play_time = nil
    state.needs_baseline = true
    state.product_state = {}
    state.building_state = {}
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
    state.last_full_play_time = nil
    state.needs_baseline = true
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
