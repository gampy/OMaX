// DESCRIPTION: Валидация и диспетчеризация входящих потоков по интеграционным скриптам-процессорам. Скрипт привязан к REST API Endpoint и исполняется при поступлении внешнего http-запроса
// VERSION: 2.2.2
// CREATED BY: Alexey Zaitsev, May 2025
// MODIFIED BY:


/**
 * @typedef {import('../declaration/om').OM} om
 */

// const { om } = require('../declaration/om');


const ENV = {    
    SETTINGS: {
        SCRIPT: 'REST API Gateway 2.2',
        QUEUE :{
            SCRIPT: 'REST API Queue Manager 2.1',
            CUBE: 'QueueSize',
            MANUAL_CALC_MODE_THRESHOLD: 5,
        },
        REQUEST: {
            PROCESSORS_MAPPING: {
                'get': 'REST API Data Service',
                'put': 'REST API Data Service',
            },
        },
        RESPONSE: {
            SCRIPT: null
        }
    }
};

/**
* Main entry function.
*/
function main() {
    const processor = new RequestProcessor(ENV.SETTINGS);
    processor.processRequest();
}

/**
 * Orchestrates the processing of incoming REST API requests.
 */
class RequestProcessor {

    /**
     * Creates an instance of RequestProcessor.
     * @param {object} params - Settings parameters.
     */
    constructor(params) 
    {
        this.params = params;
        this.request = null;
        this.script = null;
        this.start = new Date();
        this.end = null;
        this.status = "OK";
        this.errorMsg = "";
    }
    

    /**
     * Retrieves URL parameters from the request and returns them as a flat key–value object.
     *
     * @returns {Record<string, any>} URL params as { name: value, … }.
     */
    getUrlParams() {
        const requestInfo = om.common.apiServiceRequestInfo();
        const params = {};
        requestInfo.getUrlParamInfos().getAll().forEach(param => {
            params[param.getName()] = param.getValue();
        });
        return params;
    }

    /**
     * Validates the incoming request:
     * - Checks that the API request is defined and that the method is POST.
     * - Retrieves and validates the request body.
     * - Extracts the integration script name from the mapping.
     * @throws {Error} If validation fails.
     * @returns {{requestName: string, scriptName: string, body: object, requestInfo: object}} Validated data.
     */
    validateRequest() {
        const requestInfo = om.common.apiServiceRequestInfo();
        if (!requestInfo) {
            throw new Error('API request not defined');
        }

        if (requestInfo.getMethod() !== "POST") {
            throw new Error('API expects POST request');
        }

        const bodyParam = requestInfo.getBodyParamInfos().get('body');
        if (bodyParam === null) {
            throw new Error('Request body not found');
        }

        const bodyString = bodyParam.getValue();
        if (!bodyString || !bodyString.trim()) {
            throw new Error('Request body is empty');
        }

        let body;
        try {
            body = JSON.parse(bodyString);
        } catch {
            throw new Error('Incorrect JSON format');
        }

        // Extract request name from body.
        const requestName = Object.keys(body)[0];
        if (!requestName) {
            throw new Error('Request name not found in body');
        }

        // Extract integration script name from mapping.
        if (
            !Object.prototype.hasOwnProperty.call(this.params.REQUEST.PROCESSORS_MAPPING, requestName) ||
            !this.params.REQUEST.PROCESSORS_MAPPING[requestName]
        ) {
            throw new Error(`Script-processor not found for request "${requestName}". Check PROCESSORS_MAPPING in ENV.`)
        }
        const scriptName = this.params.REQUEST.PROCESSORS_MAPPING[requestName];
        
        return { requestName, scriptName, body };

    }

    /**
     * Stringifies the request body with size limit enforcement.
     * @param {any} rawData - The data to stringify.
     * @returns {string} JSON-stringified body (possibly truncated).
     */
    stringifyBody(rawData) {
        const maxLength = 65536;
        var result = (rawData == null) ? "{}" : JSON.stringify(rawData, null, 2);
        var bytes = unescape(encodeURIComponent(result));
        const size = bytes.length;

        if (size > maxLength) {
            const msg = `\nThe request is too long: ${ Math.round(size /1024) } Kb. The request content has been reduced to ${ maxLength /1024 } Kb.`;
            bytes = bytes.slice(0, maxLength - msg.length - 16);
            result = decodeURIComponent(escape(bytes));
            result += msg;
        }
        return result;
    }

    /**
     * Returns true if QUEUE and all its required subkeys are defined in params.
     * @returns {boolean}
     */
    isQueueConfigured() {
        const q = this.params.QUEUE;
        return Boolean(q && q.SCRIPT && q.CUBE && q.MANUAL_CALC_MODE_THRESHOLD != null);
    }

    /**
     * Calls a macros action
     * @param {string} macroName - The script/macro name to invoke.
     * @param {object} ENV - A nested JSON object to pass as “ENV”.
     * @param {object} vars - Flat key–value pairs to set in the environment.
     */
    callMacros(macroName, ENV, vars) {
        const macrosAction = om.common
            .resultInfo()
            .actionsInfo()
            .makeMacrosAction(macroName)
            .appendAfter()
            .environmentInfo();

        if (ENV && typeof ENV === 'object') {
            macrosAction.set('ENV', ENV);
        }

        if (vars && typeof vars === 'object') {
            for (const [key, value] of Object.entries(vars)) {
                macrosAction.set(key, value);
            }
        }
    }

    /**
         * Processes the incoming HTTP request:
         * - Increments the queue.
         * - Sets auto calculation mode based on a threshold.
         * - Validates the request.
         * - Retrieves URL parameters.
         * - Calls the target script-processor with additional URL parameters.
         * - Appends the HTTP response.
         */
    processRequest() {
        try {
            // increment queue
            if (this.isQueueConfigured()) {
                try {
                    this.callMacros(
                        this.params.QUEUE.SCRIPT, ENV, { queueInc: 1 }
                    );
                } catch {}
            }

            // Validate the incoming request.
            const { requestName, scriptName, body } = this.validateRequest();
            this.request = requestName;
            this.script = scriptName;

            // Retrieve URL parameters.
            const urlParams = this.getUrlParams();

            // Stringify body with size limit.
            const bodyString = this.stringifyBody(body);

            // Call the target script-processor.
            this.callMacros(
                scriptName, ENV, { requestName, scriptName, body, bodyString, ...urlParams }
            );

        } catch (error) {
            this.status = "ERROR";
            this.errorMsg = error.message || String(error);
            throw error;
        } finally {
            // Append the HTTP response and log script data
            if (this.params.RESPONSE.SCRIPT != null) {
                this.end = new Date();
                this.callMacros(this.params.RESPONSE.SCRIPT, ENV,
                    { 
                        requestName: this.request,
                        start: this.start.getTime(), 
                        end: this.end.getTime(),
                        scriptToLog: this.params.SCRIPT, 
                        scriptToCall: this.script,
                        status: this.status,
                        error: this.errorMsg
                    }
                );
            }

            // Cleanup: decrement queue, update auto calc status
            if (this.isQueueConfigured()) {
                try {
                    this.callMacros(
                        this.params.QUEUE.SCRIPT, ENV, { queueInc: -1 }
                    );
                } catch {}
            }
        }
    }
}

main();