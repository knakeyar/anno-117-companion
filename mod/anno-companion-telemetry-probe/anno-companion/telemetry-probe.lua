local Probe = {}

-- Set all probes to false and enable them one-by-one if the combined run fails.
local CONFIG = {
    delay_ticks_after_load = 30,
    repeat_every_ticks = 0,
    output_prefix = "ANNO_COMPANION_PROBE_JSON ",
    try_jsonl_output = true,
    jsonl_path = "logs/anno-companion-probe.jsonl",
    product_guids = { 2174, 2176, 2178, 1010017 },
    product_probe_guids = { 2174, 2176, 2178, 1010017, -1 },
    history_indices = { 0, 1, 2, 3 },
    limits = {
        areas = 64,
        population_levels_per_area = 16,
        workforces = 16,
        finance_categories = 64,
        issue_routes = 64,
        ships = 128,
        factories = 256,
        factory_products = 16,
    },
    probes = {
        transport = true,
        context = true,
        products = true,
        areas = true,
        storage = true,
        population = true,
        workforce = true,
        passive_trade = true,
        statistics = true,
        history = true,
        finance = true,
        trade_routes = true,
        ships = true,
        factories = true,
    },
}

local NULL = {}
local unpack_values = table.unpack or unpack

local state = {
    initialized = false,
    loaded = false,
    ticks_until_run = nil,
    ticks_since_run = 0,
    run_number = 0,
    sequence = 0,
    file_output_state = "disabled",
    file_output_error = nil,
    current_areas = nil,
    participant_guid = nil,
}

local function escape_json_string(value)
    local replacements = {
        ["\\"] = "\\\\",
        ["\""] = "\\\"",
        ["\b"] = "\\b",
        ["\f"] = "\\f",
        ["\n"] = "\\n",
        ["\r"] = "\\r",
        ["\t"] = "\\t",
    }

    return value:gsub('[%z\1-\31\\"]', function(character)
        return replacements[character] or string.format("\\u%04x", string.byte(character))
    end)
end

local function is_array(value)
    local count = 0
    local maximum = 0

    for key, _ in pairs(value) do
        if type(key) ~= "number" or key < 1 or key % 1 ~= 0 then
            return false
        end
        count = count + 1
        if key > maximum then
            maximum = key
        end
    end

    return maximum == count
end

local function encode_json(value, seen)
    if value == NULL or value == nil then
        return "null"
    end

    local value_type = type(value)
    if value_type == "boolean" then
        return value and "true" or "false"
    end
    if value_type == "number" then
        if value ~= value or value == math.huge or value == -math.huge then
            return "null"
        end
        return tostring(value)
    end
    if value_type == "string" then
        return "\"" .. escape_json_string(value) .. "\""
    end
    if value_type ~= "table" then
        return "\"" .. escape_json_string(tostring(value)) .. "\""
    end

    seen = seen or {}
    if seen[value] then
        return "\"<cycle>\""
    end
    seen[value] = true

    local parts = {}
    if is_array(value) then
        for index = 1, #value do
            parts[#parts + 1] = encode_json(value[index], seen)
        end
        seen[value] = nil
        return "[" .. table.concat(parts, ",") .. "]"
    end

    local keys = {}
    for key, _ in pairs(value) do
        keys[#keys + 1] = tostring(key)
    end
    table.sort(keys)

    for _, key in ipairs(keys) do
        parts[#parts + 1] = "\"" .. escape_json_string(key) .. "\":" .. encode_json(value[key], seen)
    end

    seen[value] = nil
    return "{" .. table.concat(parts, ",") .. "}"
end

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

local function append_jsonl(line)
    if not CONFIG.try_jsonl_output or not state.loaded then
        return
    end
    if state.file_output_state == "failed" then
        return
    end

    local ok, failure = pcall(function()
        if io == nil or type(io.open) ~= "function" then
            error("io.open is not available")
        end

        local file, open_error = io.open(CONFIG.jsonl_path, "a")
        if file == nil then
            error(open_error or "io.open returned nil")
        end

        file:write(line)
        file:write("\n")
        file:flush()
        file:close()
    end)

    if ok then
        state.file_output_state = "working"
        return
    end

    state.file_output_state = "failed"
    state.file_output_error = tostring(failure)
    raw_log(CONFIG.output_prefix .. encode_json({
        schema_version = 0,
        event_type = "file_output_error",
        ok = false,
        path = CONFIG.jsonl_path,
        error = state.file_output_error,
    }))
end

local function emit(event_type, probe_name, ok, data, error_message)
    state.sequence = state.sequence + 1

    local envelope = {
        schema_version = 0,
        event_type = event_type,
        probe = probe_name,
        ok = ok,
        run_number = state.run_number,
        sequence = state.sequence,
        data = data or NULL,
        error = error_message or NULL,
    }

    local line = CONFIG.output_prefix .. encode_json(envelope)
    raw_log(line)
    append_jsonl(line)
end

local function safe_value(value)
    if value == nil then
        return NULL
    end

    local value_type = type(value)
    if value_type == "string" or value_type == "number" or value_type == "boolean" then
        return value
    end

    local ok, text = pcall(function()
        return tostring(value)
    end)
    if ok then
        return text
    end
    return "<unprintable " .. value_type .. ">"
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

local function capture_fields(object, field_names)
    local values = {}
    local errors = {}

    for _, field_name in ipairs(field_names) do
        local ok, value, failure = safe_get(object, field_name)
        if ok then
            values[field_name] = safe_value(value)
        else
            values[field_name] = NULL
            errors[field_name] = failure
        end
    end

    if next(errors) ~= nil then
        values.field_errors = errors
    end
    return values
end

local function collection_values(collection, limit)
    if collection == nil then
        return nil, "collection is nil"
    end

    local values = {}
    local ok, failure = pcall(function()
        local count = #collection
        local maximum = math.min(count, limit)
        for index = 1, maximum do
            values[#values + 1] = collection[index]
        end
        values.reported_count = count
        values.truncated = count > limit
    end)

    if not ok then
        return nil, tostring(failure)
    end
    return values, nil
end

local function get_area_id(area)
    local ok, area_id = safe_get(area, "ID")
    if not ok then
        return NULL
    end
    return safe_value(area_id)
end

local function get_nested_id(object, object_field, id_field)
    local ok_object, child = safe_get(object, object_field)
    if not ok_object or child == nil then
        return NULL
    end
    local ok_id, id = safe_get(child, id_field)
    if not ok_id then
        return NULL
    end
    return safe_value(id)
end

local function get_controlled_areas()
    if state.current_areas ~= nil then
        return state.current_areas, nil
    end

    local ok, collection, failure = safe_get(Participants, "ControlledAreaList")
    if not ok then
        return nil, failure
    end

    local areas, collection_failure = collection_values(collection, CONFIG.limits.areas)
    if areas == nil then
        return nil, collection_failure
    end

    state.current_areas = areas
    return areas, nil
end

local function get_participant_guid()
    if state.participant_guid ~= nil then
        return state.participant_guid
    end

    local ok, participant_guid = safe_get(Participants, "GetCurrentParticipantGUID")
    if ok then
        state.participant_guid = participant_guid
        return participant_guid
    end
    return nil
end

local function describe_product_amount(product_amount)
    if product_amount == nil then
        return NULL
    end

    local result = capture_fields(product_amount, { "Amount" })
    local ok_product, product = safe_get(product_amount, "Product")
    if ok_product and product ~= nil then
        result.product = capture_fields(product, { "Guid", "Text", "Icon" })
    else
        result.product = NULL
    end
    return result
end

local function describe_product_amount_collection(collection, limit)
    local products, failure = collection_values(collection, limit)
    if products == nil then
        return nil, failure
    end

    local result = {}
    for index, product_amount in ipairs(products) do
        result[index] = describe_product_amount(product_amount)
    end
    result.reported_count = products.reported_count
    result.truncated = products.truncated
    return result, nil
end

local function run_probe(probe_name, callback)
    if not CONFIG.probes[probe_name] then
        emit("probe_skipped", probe_name, true, { reason = "disabled in CONFIG.probes" })
        return
    end

    emit("probe_started", probe_name, true, {})
    local ok, failure = pcall(callback)
    if ok then
        emit("probe_finished", probe_name, true, {})
    else
        emit("probe_finished", probe_name, false, nil, tostring(failure))
    end
end

local function probe_transport()
    local result = {
        system_type = type(system),
        system_log_type = system ~= nil and type(system.log) or "nil",
        system_log_info_type = system ~= nil and type(system.logInfo) or "nil",
        io_type = type(io),
        io_open_type = io ~= nil and type(io.open) or "nil",
        jsonl_attempt_enabled = CONFIG.try_jsonl_output,
        jsonl_path = CONFIG.jsonl_path,
        jsonl_state = state.file_output_state,
        jsonl_error = state.file_output_error or NULL,
    }

    local require_ok, json_module = pcall(function()
        return require("json")
    end)
    result.bundled_json_require_ok = require_ok
    if require_ok and json_module ~= nil then
        result.bundled_json_type = type(json_module)
        local encode_ok, encoded = pcall(function()
            return json_module.encode({ probe = true, value = 1 })
        end)
        result.bundled_json_encode_ok = encode_ok
        result.bundled_json_sample = encode_ok and safe_value(encoded) or NULL
        result.bundled_json_encode_error = encode_ok and NULL or safe_value(encoded)
    else
        result.bundled_json_error = safe_value(json_module)
    end

    emit("probe_result", "transport", true, result)
end

local function probe_context()
    local result = {
        globals = {
            Participants = type(Participants),
            Area = type(Area),
            AreaManager = type(AreaManager),
            EconomyStatistic = type(EconomyStatistic),
            GameClock = type(GameClock),
            GameSession = type(GameSession),
            GameSetup = type(GameSetup),
            Money = type(Money),
            Scripts = type(Scripts),
            TradeRoute = type(TradeRoute),
            Properties = type(Properties),
            Static = type(Static),
        },
        participant = capture_fields(Participants, {
            "GetCurrentParticipantGUID",
            "Human0ParticipantGUID",
            "Human1ParticipantGUID",
            "Human2ParticipantGUID",
            "Human3ParticipantGUID",
        }),
        game_session = capture_fields(GameSession, { "SessionGUID", "RegionGUID", "IsCurrentAreaValidIsland" }),
        game_clock = capture_fields(GameClock, { "CorporationTime", "PlayTime", "GameSpeed" }),
        game = capture_fields(Game, { "PlayTime" }),
        savegame = capture_fields(Savegame, { "TimeSinceSaving" }),
        scenario = capture_fields(Scenarios, { "ScenarioGUID" }),
    }

    local ok_setup, current_setup = safe_get(GameSetup, "CurrentGameSetup")
    if ok_setup and current_setup ~= nil then
        result.game_setup = capture_fields(current_setup, {
            "IsActive",
            "IsCampaignEnabled",
            "IsScenarioEnabled",
            "GameSeed",
            "DifficultyLevel",
        })
    else
        result.game_setup = NULL
        result.game_setup_error = safe_value(current_setup)
    end

    local ok_current, current_area = safe_get(Area, "Current")
    if ok_current and current_area ~= nil then
        result.current_area = capture_fields(current_area, {
            "ID",
            "CityName",
            "Owner",
            "IsOwnedByCurrentParticipant",
            "HasAreaEconomy",
        })
    else
        result.current_area = NULL
    end

    local ok_selected, selected_area = safe_get(Area, "CurrentSelectedArea")
    if ok_selected and selected_area ~= nil then
        result.selected_area = capture_fields(selected_area, {
            "ID",
            "CityName",
            "Owner",
            "IsOwnedByCurrentParticipant",
            "HasAreaEconomy",
        })
    else
        result.selected_area = NULL
    end

    emit("probe_result", "context", true, result)
end

local function probe_products()
    for _, product_guid in ipairs(CONFIG.product_probe_guids) do
        local result = { product_guid = product_guid }

        local valid_ok, valid_or_error = pcall(function()
            return IsProduct(product_guid)
        end)
        result.is_product = valid_ok and safe_value(valid_or_error) or NULL
        result.is_product_error = valid_ok and NULL or safe_value(valid_or_error)

        local asset_ok, asset_or_error = pcall(function()
            return GetProductAssetData(product_guid)
        end)
        if asset_ok and asset_or_error ~= nil then
            result.asset = capture_fields(asset_or_error, {
                "Guid",
                "Text",
                "Icon",
                "IsWorkforce",
                "IsAbstract",
                "IsValid",
                "AllowedInCurrentRegion",
                "CanBeProducedInCurrentRegion",
            })
        else
            result.asset = NULL
            result.asset_error = safe_value(asset_or_error)
        end

        emit("probe_result", "products", valid_ok and asset_ok, result)
    end
end

local function probe_areas()
    local areas, failure = get_controlled_areas()
    if areas == nil then
        error(failure)
    end

    emit("probe_result", "areas", true, {
        reported_count = areas.reported_count,
        captured_count = #areas,
        truncated = areas.truncated,
        current_game_session_guid = capture_fields(GameSession, { "SessionGUID", "RegionGUID" }),
    })

    for index, area in ipairs(areas) do
        local result = capture_fields(area, {
            "ID",
            "CityName",
            "OwnerName",
            "Owner",
            "VassalOrAreaOwner",
            "AreaOwnerIsCurrentParticipant",
            "IsOwnedByAnyone",
            "IsOwnedByCurrentParticipant",
            "HasAreaEconomy",
            "KontorID",
            "HasTradeRights",
            "IsIslandWarActive",
        })
        result.index = index

        local ok_id, area_id = safe_get(area, "ID")
        if ok_id and area_id ~= nil then
            result.area_id_type = type(area_id)
            result.area_id_flags = capture_fields(area_id, { "IsValid", "IsInvalid", "IsIslandArea", "IsGlobal" })

            local manager_ok, manager_or_error = pcall(function()
                return GetAreaManagerByID(area_id)
            end)
            result.area_manager_lookup_ok = manager_ok
            if manager_ok and manager_or_error ~= nil then
                result.area_manager = capture_fields(manager_or_error, { "ConstructionArea" })
            else
                result.area_manager_error = safe_value(manager_or_error)
            end
        end

        emit("probe_result", "areas", true, result)
    end
end

local function probe_storage()
    local areas, failure = get_controlled_areas()
    if areas == nil then
        error(failure)
    end

    for area_index, area in ipairs(areas) do
        local area_id = get_area_id(area)
        local economy_ok, economy, economy_error = safe_get(area, "Economy")
        if not economy_ok or economy == nil then
            emit("probe_result", "storage", false, {
                area_index = area_index,
                area_id = area_id,
            }, economy_error or "area economy is nil")
        else
            for _, product_guid in ipairs(CONFIG.product_guids) do
                local result = {
                    area_index = area_index,
                    area_id = area_id,
                    product_guid = product_guid,
                }
                local call_errors = {}

                local calls = {
                    stock = function() return economy:GetStorageAmount(product_guid) end,
                    available = function() return economy:GetAvailableAmount(product_guid) end,
                    capacity = function() return economy:GetStorageCapacity(product_guid) end,
                    reserved = function() return economy:GetReservedStorageAmount(product_guid) end,
                    free_space = function() return economy:GetFreeSpace(product_guid) end,
                    engine_trend = function() return economy:GetStorageTrend(product_guid) end,
                    overflow_capacity = function() return economy:GetOverflowStorageCapacity(product_guid) end,
                    overflowing_amount = function() return economy:GetOverflowingAmount(product_guid) end,
                }

                for name, callback in pairs(calls) do
                    local ok, value = pcall(callback)
                    result[name] = ok and safe_value(value) or NULL
                    if not ok then
                        call_errors[name] = safe_value(value)
                    end
                end

                if next(call_errors) ~= nil then
                    result.call_errors = call_errors
                end
                emit("probe_result", "storage", next(call_errors) == nil, result)
            end
        end
    end
end

local function probe_population()
    local areas, failure = get_controlled_areas()
    if areas == nil then
        error(failure)
    end

    for area_index, area in ipairs(areas) do
        local area_id_ok, area_id = safe_get(area, "ID")
        if not area_id_ok then
            emit("probe_result", "population", false, { area_index = area_index }, "cannot read area ID")
        else
            local manager_ok, manager_or_error = pcall(function()
                return GetAreaManagerByID(area_id)
            end)
            if not manager_ok or manager_or_error == nil then
                emit("probe_result", "population", false, {
                    area_index = area_index,
                    area_id = safe_value(area_id),
                }, safe_value(manager_or_error))
            else
                local population_ok, population, population_error = safe_get(manager_or_error, "AreaPopulation")
                if not population_ok or population == nil then
                    emit("probe_result", "population", false, {
                        area_index = area_index,
                        area_id = safe_value(area_id),
                    }, population_error or "AreaPopulation is nil")
                else
                    local result = capture_fields(population, {
                        "PopulationCount",
                        "CityStatus",
                        "CityStatusName",
                        "CityStatusLevel",
                        "AmountOfResidences",
                        "DominantPopulationOrPopulationGroup",
                    })
                    result.area_index = area_index
                    result.area_id = safe_value(area_id)
                    emit("probe_result", "population", true, result)

                    local levels_ok, levels, levels_error = safe_get(population, "PopulationLevels")
                    if levels_ok and levels ~= nil then
                        local level_values, level_collection_error = collection_values(
                            levels,
                            CONFIG.limits.population_levels_per_area
                        )
                        if level_values ~= nil then
                            for level_index, level in ipairs(level_values) do
                                local level_result = capture_fields(level, { "Guid", "Text", "Icon", "Workforce" })
                                level_result.area_id = safe_value(area_id)
                                level_result.level_index = level_index

                                local guid_ok, population_guid = safe_get(level, "Guid")
                                if guid_ok and population_guid ~= nil then
                                    local count_ok, count_or_error = pcall(function()
                                        return population:GetPopulationCount(population_guid)
                                    end)
                                    level_result.population_count = count_ok and safe_value(count_or_error) or NULL
                                    level_result.population_count_error = count_ok and NULL or safe_value(count_or_error)

                                    local satisfaction_ok, satisfaction_or_error = pcall(function()
                                        return population:GetSatisfaction(population_guid)
                                    end)
                                    level_result.satisfaction = satisfaction_ok and safe_value(satisfaction_or_error) or NULL
                                    level_result.satisfaction_error = satisfaction_ok and NULL or safe_value(satisfaction_or_error)
                                end

                                emit("probe_result", "population", true, level_result)
                            end
                        else
                            emit("probe_result", "population", false, {
                                area_id = safe_value(area_id),
                            }, level_collection_error)
                        end
                    else
                        emit("probe_result", "population", false, {
                            area_id = safe_value(area_id),
                        }, levels_error or "PopulationLevels is nil")
                    end
                end
            end
        end
    end
end

local function probe_workforce()
    local result = {
        selected_area_id = NULL,
        workforces_global_type = type(AreaWorkforce),
    }

    local selected_ok, selected_area = safe_get(Area, "CurrentSelectedArea")
    if selected_ok and selected_area ~= nil then
        result.selected_area_id = get_area_id(selected_area)
    end

    local workforces_ok, workforces, workforces_error = safe_get(AreaWorkforce, "Workforces")
    if not workforces_ok or workforces == nil then
        emit("probe_result", "workforce", false, result, workforces_error or "Workforces is nil")
        return
    end

    local workforce_values, collection_error = collection_values(workforces, CONFIG.limits.workforces)
    if workforce_values == nil then
        emit("probe_result", "workforce", false, result, collection_error)
        return
    end

    result.reported_count = workforce_values.reported_count
    result.captured_count = #workforce_values
    result.truncated = workforce_values.truncated
    emit("probe_result", "workforce", true, result)

    for workforce_index, workforce in ipairs(workforce_values) do
        local workforce_result = capture_fields(workforce, {
            "Guid",
            "Text",
            "Icon",
            "Value",
            "ValueAsFloat",
        })
        workforce_result.selected_area_id = result.selected_area_id
        workforce_result.workforce_index = workforce_index

        local guid_ok, workforce_guid = safe_get(workforce, "Guid")
        if guid_ok and workforce_guid ~= nil then
            local errors = {}
            local calls = {
                delta_without_buffs = function() return AreaWorkforce:Delta(workforce_guid, false) end,
                delta_with_buffs = function() return AreaWorkforce:Delta(workforce_guid, true) end,
                population_count = function() return AreaWorkforce:GetPopulationCount(workforce_guid) end,
                resulting_from_population = function()
                    return AreaWorkforce:GetWorkforceResultingFromPopulation(workforce_guid)
                end,
                registered_production = function()
                    return AreaWorkforce:RegisteredDeltaProduction(workforce_guid)
                end,
                registered_consumption = function()
                    return AreaWorkforce:RegisteredDeltaConsumption(workforce_guid)
                end,
                buffed_delta = function() return AreaWorkforce:GetBuffedDelta(workforce_guid) end,
            }

            for name, callback in pairs(calls) do
                local ok, value = pcall(callback)
                workforce_result[name] = ok and safe_value(value) or NULL
                if not ok then
                    errors[name] = safe_value(value)
                end
            end

            local product_ok, product_or_error = pcall(function()
                return GetProductAssetData(workforce_guid)
            end)
            if product_ok and product_or_error ~= nil then
                workforce_result.product_asset = capture_fields(product_or_error, {
                    "Guid",
                    "Text",
                    "IsWorkforce",
                    "IsAbstract",
                    "IsValid",
                })
            else
                workforce_result.product_asset_error = safe_value(product_or_error)
            end

            if next(errors) ~= nil then
                workforce_result.call_errors = errors
            end
        end

        emit("probe_result", "workforce", true, workforce_result)
    end
end

local function probe_passive_trade()
    local areas, failure = get_controlled_areas()
    if areas == nil then
        error(failure)
    end

    for area_index, area in ipairs(areas) do
        local area_id = get_area_id(area)
        local controller_ok, controller, controller_error = safe_get(area, "PassiveTrade")
        if not controller_ok or controller == nil then
            emit("probe_result", "passive_trade", false, {
                area_index = area_index,
                area_id = area_id,
            }, controller_error or "PassiveTrade is nil")
        else
            for _, product_guid in ipairs(CONFIG.product_guids) do
                local result = {
                    area_index = area_index,
                    area_id = area_id,
                    product_guid = product_guid,
                }

                local minimum_ok, minimum_or_error = pcall(function()
                    return controller:GetMinimumStockForProductOrBulk(product_guid)
                end)
                result.minimum_stock = minimum_ok and safe_value(minimum_or_error) or NULL
                result.minimum_stock_error = minimum_ok and NULL or safe_value(minimum_or_error)

                local offer_ok, offer_or_error = pcall(function()
                    return controller:GetOfferOrBulkOffer(product_guid)
                end)
                if offer_ok and offer_or_error ~= nil then
                    result.offer = capture_fields(offer_or_error, {
                        "IsSellOnly",
                        "IsBuyOnly",
                        "IsBuyOrSell",
                        "IsNoOffer",
                        "IsPreferedGood",
                    })
                else
                    result.offer = NULL
                    result.offer_error = safe_value(offer_or_error)
                end

                emit("probe_result", "passive_trade", minimum_ok and offer_ok, result)
            end

            local offer_collections = {
                BuyOffers = function()
                    return controller.BuyOffers
                end,
                SellOffers = function()
                    return controller:SellOffers()
                end,
            }
            for collection_name, callback in pairs(offer_collections) do
                local collection_ok, collection_or_error = pcall(callback)
                if collection_ok and collection_or_error ~= nil then
                    local offers, offers_error = collection_values(collection_or_error, 64)
                    if offers ~= nil then
                        for offer_index, offer in ipairs(offers) do
                            local offer_result = capture_fields(offer, { "Guid", "Price", "Amount", "EndlessAmount" })
                            offer_result.area_id = area_id
                            offer_result.collection = collection_name
                            offer_result.offer_index = offer_index
                            emit("probe_result", "passive_trade", true, offer_result)
                        end
                    else
                        emit("probe_result", "passive_trade", false, {
                            area_id = area_id,
                            collection = collection_name,
                        }, offers_error)
                    end
                else
                    emit("probe_result", "passive_trade", false, {
                        area_id = area_id,
                        collection = collection_name,
                    }, safe_value(collection_or_error))
                end
            end
        end
    end
end

local function probe_statistics()
    local result = capture_fields(EconomyStatistic, { "NumOfSelectedAreas" })
    result.selected_area_id = NULL

    local selected_ok, selected_area = safe_get(Area, "CurrentSelectedArea")
    if selected_ok and selected_area ~= nil then
        result.selected_area_id = get_area_id(selected_area)
    end

    local statistics_ok, statistics, statistics_error = safe_get(EconomyStatistic, "ProductionStatistic")
    if not statistics_ok or statistics == nil then
        emit("probe_result", "statistics", false, result, statistics_error or "ProductionStatistic is nil")
        return
    end

    emit("probe_result", "statistics", true, result)
    for _, product_guid in ipairs(CONFIG.product_guids) do
        local product_result = {
            selected_area_id = result.selected_area_id,
            product_guid = product_guid,
        }
        local errors = {}
        local calls = {
            generation_per_minute = function() return statistics:ProductGeneration(product_guid) end,
            consumption_per_minute = function() return statistics:ProductConsumption(product_guid) end,
            delta_per_minute = function() return statistics:ProductDelta(product_guid) end,
            perfect_generation_per_minute = function() return statistics:PerfectProductGeneration(product_guid) end,
            perfect_consumption_per_minute = function() return statistics:PerfectProductConsumption(product_guid) end,
        }
        for name, callback in pairs(calls) do
            local ok, value = pcall(callback)
            product_result[name] = ok and safe_value(value) or NULL
            if not ok then
                errors[name] = safe_value(value)
            end
        end
        if next(errors) ~= nil then
            product_result.call_errors = errors
        end
        emit("probe_result", "statistics", next(errors) == nil, product_result)
    end
end

local function probe_history()
    local history_ok, history, history_error = safe_get(EconomyStatistic, "History")
    if not history_ok or history == nil then
        error(history_error or "History is nil")
    end

    local product_guid = CONFIG.product_guids[1]
    for _, snapshot_index in ipairs(CONFIG.history_indices) do
        local result = {
            snapshot_index = snapshot_index,
            product_guid = product_guid,
        }
        local errors = {}
        local calls = {
            time_since_snapshot = function() return history:GetTimeSinceSnapshot(snapshot_index) end,
            product_amount = function() return history:GetProductAmount(snapshot_index, product_guid) end,
            product_generation = function() return history:GetProductGeneration(snapshot_index, product_guid) end,
            product_consumption = function() return history:GetProductConsumption(snapshot_index, product_guid) end,
        }
        for name, callback in pairs(calls) do
            local ok, value = pcall(callback)
            result[name] = ok and safe_value(value) or NULL
            if not ok then
                errors[name] = safe_value(value)
            end
        end
        if next(errors) ~= nil then
            result.call_errors = errors
        end
        emit("probe_result", "history", next(errors) == nil, result)
    end
end

local function emit_finance_collection(collection_name, collection)
    local entries, failure = collection_values(collection, CONFIG.limits.finance_categories)
    if entries == nil then
        emit("probe_result", "finance", false, { collection = collection_name }, failure)
        return
    end

    emit("probe_result", "finance", true, {
        collection = collection_name,
        reported_count = entries.reported_count,
        captured_count = #entries,
        truncated = entries.truncated,
    })
    for index, entry in ipairs(entries) do
        local result = capture_fields(entry, { "Guid", "Text", "Value", "ValueAsFloat" })
        result.collection = collection_name
        result.index = index
        emit("probe_result", "finance", true, result)
    end
end

local function probe_finance()
    emit("probe_result", "finance", true, {
        participant_guid = safe_value(get_participant_guid()),
        money = capture_fields(Money, {
            "TotalIncome",
            "TradeBalance",
            "PassiveTradeBalance",
            "ActiveTradeBalance",
        }),
    })

    local positive_ok, positive = safe_get(Money, "PositiveMoneyPerCategory")
    if positive_ok and positive ~= nil then
        emit_finance_collection("positive", positive)
    end
    local negative_ok, negative = safe_get(Money, "NegativeMoneyPerCategory")
    if negative_ok and negative ~= nil then
        emit_finance_collection("negative", negative)
    end

    local meta_storage_ok, meta_storage, meta_storage_error = safe_get(Economy, "MetaStorage")
    if meta_storage_ok and meta_storage ~= nil then
        local treasury_ok, treasury_or_error = pcall(function()
            return meta_storage:GetStorageAmount(1010017)
        end)
        emit("probe_result", "finance", treasury_ok, {
            product_guid = 1010017,
            treasury_candidate = treasury_ok and safe_value(treasury_or_error) or NULL,
        }, treasury_ok and nil or safe_value(treasury_or_error))
    else
        emit("probe_result", "finance", false, nil, meta_storage_error or "MetaStorage is nil")
    end

    local areas, areas_error = get_controlled_areas()
    if areas == nil then
        emit("probe_result", "finance", false, nil, areas_error)
        return
    end

    for area_index, area in ipairs(areas) do
        local area_id_ok, area_id = safe_get(area, "ID")
        if area_id_ok then
            local manager_ok, manager_or_error = pcall(function()
                return GetAreaManagerByID(area_id)
            end)
            if manager_ok and manager_or_error ~= nil then
                local area_money_ok, area_money = safe_get(manager_or_error, "AreaMoney")
                if area_money_ok and area_money ~= nil then
                    emit("probe_result", "finance", true, {
                        area_index = area_index,
                        area_id = safe_value(area_id),
                        area_money = capture_fields(area_money, { "TotalMoneyIncome", "LandTax" }),
                    })
                end
            end
        end
    end
end

local function probe_trade_routes()
    local routes_ok, routes, routes_error = safe_get(TradeRoute, "TradeRoutesWithIssues")
    if not routes_ok or routes == nil then
        error(routes_error or "TradeRoutesWithIssues is nil")
    end

    local route_values, collection_error = collection_values(routes, CONFIG.limits.issue_routes)
    if route_values == nil then
        error(collection_error)
    end

    emit("probe_result", "trade_routes", true, {
        reported_count = route_values.reported_count,
        captured_count = #route_values,
        truncated = route_values.truncated,
    })

    for route_index, route in ipairs(route_values) do
        local result = capture_fields(route, {
            "Name",
            "NotEnoughStationsActive",
            "NoGoodsActive",
            "NoShipsActive",
            "AllShipsPausedActive",
            "ActiveErrorCount",
        })
        result.route_index = route_index
        result.active_error_types = {}
        result.error_call_failures = {}

        for error_type = 0, 16 do
            local error_ok, active_or_error = pcall(function()
                return route:IsErrorActive(error_type)
            end)
            if error_ok and active_or_error then
                result.active_error_types[#result.active_error_types + 1] = error_type
            elseif not error_ok then
                result.error_call_failures[tostring(error_type)] = safe_value(active_or_error)
            end
        end

        if next(result.error_call_failures) == nil then
            result.error_call_failures = nil
        end
        emit("probe_result", "trade_routes", true, result)
    end

    local edit_ok, edit_route = safe_get(TradeRoute, "UIEditRoute")
    if edit_ok and edit_route ~= nil then
        emit("probe_result", "trade_routes", true, {
            ui_edit_route = capture_fields(edit_route, {
                "Name",
                "NotEnoughStationsActive",
                "NoGoodsActive",
                "NoShipsActive",
                "AllShipsPausedActive",
                "ActiveErrorCount",
            }),
        })
    end
end

local function get_objects_by_property(property_value)
    local participant_guid = get_participant_guid()
    if participant_guid == nil then
        return nil, "participant GUID is unavailable"
    end

    local ok, objects_or_error = pcall(function()
        return Scripts:GetObjectGroupByProperty(property_value, participant_guid)
    end)
    if not ok then
        return nil, tostring(objects_or_error)
    end
    return objects_or_error, nil
end

local function probe_ships()
    local property_ok, property_value, property_error = safe_get(Properties, "TradeRouteVehicle")
    if not property_ok then
        error(property_error)
    end

    local objects, objects_error = get_objects_by_property(property_value)
    if objects == nil then
        error(objects_error)
    end

    local ships, collection_error = collection_values(objects, CONFIG.limits.ships)
    if ships == nil then
        error(collection_error)
    end

    emit("probe_result", "ships", true, {
        property_value = safe_value(property_value),
        reported_count = ships.reported_count,
        captured_count = #ships,
        truncated = ships.truncated,
    })

    for ship_index, ship in ipairs(ships) do
        local result = capture_fields(ship, {
            "ID",
            "GUID",
            "Owner",
            "SessionGuid",
            "Position",
            "Position2D",
            "IsOwnedByCurrentParticipant",
        })
        result.ship_index = ship_index
        result.area_id = get_nested_id(ship, "Area", "ID")

        local route_vehicle_ok, route_vehicle = safe_get(ship, "TradeRouteVehicle")
        if route_vehicle_ok and route_vehicle ~= nil then
            result.trade_route_vehicle = capture_fields(route_vehicle, {
                "IsAssignedOnTradeRoute",
                "RouteName",
                "IsPaused",
                "OnRegularRoute",
                "LoadingSpeedFactor",
            })
        else
            result.trade_route_vehicle = NULL
        end

        local logistic_ok, logistic = safe_get(ship, "Logistic")
        result.logistic_property_readable = logistic_ok and logistic ~= nil
        if logistic_ok and logistic ~= nil then
            result.cargo_candidates = {}
            for _, product_guid in ipairs(CONFIG.product_guids) do
                local cargo = { product_guid = product_guid }
                local amount_ok, amount_or_error = pcall(function()
                    return logistic:GetStorageAmount(product_guid)
                end)
                cargo.amount = amount_ok and safe_value(amount_or_error) or NULL
                cargo.amount_error = amount_ok and NULL or safe_value(amount_or_error)

                local capacity_ok, capacity_or_error = pcall(function()
                    return logistic:GetStorageCapacity(product_guid)
                end)
                cargo.capacity = capacity_ok and safe_value(capacity_or_error) or NULL
                cargo.capacity_error = capacity_ok and NULL or safe_value(capacity_or_error)
                result.cargo_candidates[#result.cargo_candidates + 1] = cargo
            end
        end

        emit("probe_result", "ships", true, result)
    end
end

local function probe_factories()
    local property_ok, property_value, property_error = safe_get(Properties, "Factory7")
    if not property_ok then
        error(property_error)
    end

    local objects, objects_error = get_objects_by_property(property_value)
    if objects == nil then
        error(objects_error)
    end

    local factories, collection_error = collection_values(objects, CONFIG.limits.factories)
    if factories == nil then
        error(collection_error)
    end

    emit("probe_result", "factories", true, {
        property_value = safe_value(property_value),
        reported_count = factories.reported_count,
        captured_count = #factories,
        truncated = factories.truncated,
    })

    for factory_index, object in ipairs(factories) do
        local result = capture_fields(object, { "ID", "GUID", "Owner", "SessionGuid" })
        result.factory_index = factory_index
        result.area_id = get_nested_id(object, "Area", "ID")

        local factory_ok, factory = safe_get(object, "Factory")
        if factory_ok and factory ~= nil then
            result.factory = capture_fields(factory, {
                "FillStorage",
                "CycleTime",
                "RelativeCycleTime",
                "Progress",
                "Productivity",
                "CurrentProductivity",
                "ProductivityBase",
                "ProductivityUpgrade",
                "FullOutputStorage",
                "NoWarehouseInRange",
                "NeedsAFertility",
                "HasNeededFertility",
                "RemainingFuelTime",
                "HasFuelWarning",
            })
            local inputs_ok, inputs = safe_get(factory, "Inputs")
            if inputs_ok and inputs ~= nil then
                local input_values, input_error = describe_product_amount_collection(
                    inputs,
                    CONFIG.limits.factory_products
                )
                result.factory.inputs = input_values or NULL
                result.factory.inputs_error = input_error or NULL
            end
        else
            result.factory = NULL
        end

        local pausable_ok, pausable = safe_get(object, "Pausable")
        if pausable_ok and pausable ~= nil then
            result.pausable = capture_fields(pausable, {
                "IsPaused",
                "IsPausedByMissingStreet",
                "IsPausedByAttack",
            })
        end

        local maintenance_ok, maintenance = safe_get(object, "Maintenance")
        if maintenance_ok and maintenance ~= nil then
            result.maintenance = capture_fields(maintenance, {
                "ConsumerPriority",
                "DeltaInputSaturation",
                "HomeAreaName",
            })
        end

        local guid_ok, object_guid = safe_get(object, "GUID")
        if guid_ok and object_guid ~= nil then
            local static_ok, static_error = pcall(function()
                local inputs = Static.Factory.GetInputs(object_guid)
                local outputs = Static.Factory.GetOutputs(object_guid)
                local cycle_time = Static.Factory.GetCycleTime(object_guid)
                local workforce = Static.Maintenance.GetWorkforce(object_guid)

                local static_inputs, input_failure = describe_product_amount_collection(
                    inputs,
                    CONFIG.limits.factory_products
                )
                local static_outputs, output_failure = describe_product_amount_collection(
                    outputs,
                    CONFIG.limits.factory_products
                )
                result.static_factory = {
                    cycle_time = safe_value(cycle_time),
                    inputs = static_inputs or NULL,
                    inputs_error = input_failure or NULL,
                    outputs = static_outputs or NULL,
                    outputs_error = output_failure or NULL,
                    workforce = workforce ~= nil and capture_fields(workforce, { "Guid", "Text", "Icon" }) or NULL,
                }
            end)
            if not static_ok then
                result.static_factory_error = safe_value(static_error)
            end
        end

        emit("probe_result", "factories", true, result)
    end
end

local PROBE_ORDER = {
    { "transport", probe_transport },
    { "context", probe_context },
    { "products", probe_products },
    { "areas", probe_areas },
    { "storage", probe_storage },
    { "population", probe_population },
    { "workforce", probe_workforce },
    { "passive_trade", probe_passive_trade },
    { "statistics", probe_statistics },
    { "history", probe_history },
    { "finance", probe_finance },
    { "trade_routes", probe_trade_routes },
    { "ships", probe_ships },
    { "factories", probe_factories },
}

function Probe:RunAll()
    state.run_number = state.run_number + 1
    state.current_areas = nil
    state.participant_guid = nil

    emit("probe_run_started", "all", true, {
        delay_ticks_after_load = CONFIG.delay_ticks_after_load,
        product_guids = CONFIG.product_guids,
        enabled_probes = CONFIG.probes,
    })

    for _, entry in ipairs(PROBE_ORDER) do
        run_probe(entry[1], entry[2])
    end

    emit("probe_run_finished", "all", true, {
        file_output_state = state.file_output_state,
        file_output_error = state.file_output_error or NULL,
    })
end

function Probe:Init()
    state.initialized = true
    state.file_output_state = CONFIG.try_jsonl_output and "not_attempted" or "disabled"
    raw_log(CONFIG.output_prefix .. encode_json({
        schema_version = 0,
        event_type = "probe_initialized",
        ok = true,
        version = "0.1.1",
    }))
end

function Probe:Load()
    state.loaded = true
    state.ticks_until_run = CONFIG.delay_ticks_after_load
    state.ticks_since_run = 0
    state.current_areas = nil
    state.participant_guid = nil

    emit("probe_load_callback", "lifecycle", true, {
        scheduled_after_ticks = CONFIG.delay_ticks_after_load,
    })
end

function Probe:Unload()
    emit("probe_unload_callback", "lifecycle", true, {})
    state.loaded = false
    state.ticks_until_run = nil
    state.ticks_since_run = 0
    state.current_areas = nil
    state.participant_guid = nil
end

function Probe:Tick()
    if not state.loaded then
        return
    end

    if state.ticks_until_run ~= nil then
        state.ticks_until_run = state.ticks_until_run - 1
        if state.ticks_until_run <= 0 then
            state.ticks_until_run = nil
            self:RunAll()
        end
        return
    end

    if CONFIG.repeat_every_ticks > 0 then
        state.ticks_since_run = state.ticks_since_run + 1
        if state.ticks_since_run >= CONFIG.repeat_every_ticks then
            state.ticks_since_run = 0
            self:RunAll()
        end
    end
end

return Probe
