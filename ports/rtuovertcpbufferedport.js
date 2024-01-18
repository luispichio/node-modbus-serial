"use strict";
const events = require("events");
const EventEmitter = events.EventEmitter || events;
const net = require("net");
const modbusSerialDebug = require("debug")("modbus-serial");

/* TODO: const should be set once, maybe */
const EXCEPTION_LENGTH = 5;
const MIN_DATA_LENGTH = 6;
const MIN_WRITE_DATA_LENGTH = 4;
const MAX_BUFFER_LENGTH = 256;
const CRC_LENGTH = 2;
const READ_DEVICE_IDENTIFICATION_FUNCTION_CODE = 43;
const REPORT_SERVER_ID_FUNCTION_CODE = 17;
const LENGTH_UNKNOWN = "unknown";
const BITS_TO_NUM_OF_OBJECTS = 7;

const MODBUS_PORT = 502;

// Helper function -> Bool
// BIT | TYPE
// 8 | OBJECTID
// 9 | length of OBJECTID
// 10 -> n | the object
// 10 + n + 1 | new object id
const calculateFC43Length = function(buffer, numObjects, i, bufferLength) {
    const result = { hasAllData: true };
    let currentByte = 8 + i; // current byte starts at object id.
    if (numObjects > 0) {
        for (let j = 0; j < numObjects; j++) {
            if (bufferLength < currentByte) {
                result.hasAllData = false;
                break;
            }
            const objLength = buffer[currentByte + 1];
            if (!objLength) {
                result.hasAllData = false;
                break;
            }
            currentByte += 2 + objLength;
        }
    }
    if (currentByte + CRC_LENGTH > bufferLength) {
        // still waiting on the CRC!
        result.hasAllData = false;
    }
    if (result.hasAllData) {
        result.bufLength = currentByte + CRC_LENGTH;
    }
    return result;
};

class RTUOverTCPBufferedPort extends EventEmitter {
    /**
     * Simulate a modbus-RTU port using buffered serial connection.
     *
     * @param path
     * @param options
     * @constructor
     */
    constructor(ip, options) {
        super();

        const self = this;
        const modbus = this;
        modbus.openFlag = false;
        modbus.callback = null;
        modbus._transactionIdWrite = 1;
        this._externalSocket = null;

        // options
        if(typeof ip === "object") {
            options = ip;
        }
        if (typeof options === "undefined") options = {};
        modbus.connectOptions = {
            host: ip || options.ip,
            port: options.port || MODBUS_PORT,
            localAddress: options.localAddress,
            family: options.family || 0
        };

        if(options.socket) {
            if(options.socket instanceof net.Socket) {
                this._externalSocket = options.socket;
                this.openFlag = this._externalSocket.readyState === "opening" || this._externalSocket.readyState === "open";
            } else {
                throw new Error("invalid socket provided");
            }
        }


        // internal buffer
        this._buffer = Buffer.alloc(0);
        this._id = 0;
        this._cmd = 0;
        this._length = 0;

        // handle callback - call a callback function only once, for the first event
        // it will triger
        const handleCallback = function(had_error) {
            if (modbus.callback) {
                modbus.callback(had_error);
                modbus.callback = null;
            }
        };

        // create a socket
        modbus._client = this._externalSocket || new net.Socket();
        if (options.timeout) this._client.setTimeout(options.timeout);

        // register the port data event
        this._client.on("data", function onData(data) {
            // add data to buffer
            self._buffer = Buffer.concat([self._buffer, data]);

            modbusSerialDebug({ action: "receive serial rtu overt tcp buffered port", data: data, buffer: self._buffer });

            // check if buffer include a complete modbus answer
            const expectedLength = self._length;
            let bufferLength = self._buffer.length;


            // check data length
            if (expectedLength !== LENGTH_UNKNOWN &&
                expectedLength < MIN_DATA_LENGTH ||
                bufferLength < EXCEPTION_LENGTH
            ) { return; }

            // check buffer size for MAX_BUFFER_SIZE
            if (bufferLength > MAX_BUFFER_LENGTH) {
                self._buffer = self._buffer.slice(-MAX_BUFFER_LENGTH);
                bufferLength = MAX_BUFFER_LENGTH;
            }

            // loop and check length-sized buffer chunks
            const maxOffset = bufferLength - EXCEPTION_LENGTH;

            for (let i = 0; i <= maxOffset; i++) {
                const unitId = self._buffer[i];
                const functionCode = self._buffer[i + 1];

                if (unitId !== self._id) continue;

                if (functionCode === self._cmd && functionCode === READ_DEVICE_IDENTIFICATION_FUNCTION_CODE) {
                    if (bufferLength <= BITS_TO_NUM_OF_OBJECTS + i) {
                        return;
                    }
                    const numObjects = self._buffer[7 + i];
                    const result = calculateFC43Length(self._buffer, numObjects, i, bufferLength);
                    if (result.hasAllData) {
                        self._emitData(i, result.bufLength);
                        return;
                    }
                } else if (functionCode === self._cmd && functionCode === REPORT_SERVER_ID_FUNCTION_CODE) {
                    const contentLength = self._buffer[i + 2];
                    self._emitData(i, contentLength + 5); // length + serverID + status + contentLength + CRC
                    return;
                } else {
                    if (functionCode === self._cmd && i + expectedLength <= bufferLength) {
                        self._emitData(i, expectedLength);
                        return;
                    }
                    if (functionCode === (0x80 | self._cmd) && i + EXCEPTION_LENGTH <= bufferLength) {
                        self._emitData(i, EXCEPTION_LENGTH);
                        return;
                    }
                }

                // frame header matches, but still missing bytes pending
                if (functionCode === (0x7f & self._cmd)) break;
            }
        });

        this._client.on("connect", function() {
            modbus.openFlag = true;
            handleCallback();
        });

        this._client.on("close", function(had_error) {
            modbus.openFlag = false;
            handleCallback(had_error);
            modbus.emit("close");
        });

        this._client.on("error", function(had_error) {
            modbus.openFlag = false;
            handleCallback(had_error);
        });

        this._client.on("timeout", function() {
            // modbus.openFlag is left in its current state as it reflects two types of timeouts,
            // i.e. 'false' for "TCP connection timeout" and 'true' for "Modbus response timeout"
            // (this allows to continue Modbus request re-tries without reconnecting TCP).
            modbusSerialDebug("RTUOverTCPBufferedPort port: TimedOut");
            handleCallback(new Error("RTUOverTCPBufferedPort Connection Timed Out"));
        });
    }

    /**
     * Check if port is open.
     *
     * @returns {boolean}
     */
    get isOpen() {
        return this.openFlag;
    }

    /**
     * Emit the received response, cut the buffer and reset the internal vars.
     *
     * @param {number} start The start index of the response within the buffer.
     * @param {number} length The length of the response.
     * @private
     */
    _emitData(start, length) {
        const buffer = this._buffer.slice(start, start + length);
        modbusSerialDebug({ action: "emit data serial rtu over tcp buffered port", buffer: buffer });
        this.emit("data", buffer);
        this._buffer = this._buffer.slice(start + length);
    }

    /**
     * Simulate successful port open.
     *
     * @param callback
     */
    open(callback) {
        if(this._externalSocket === null) {
            this.callback = callback;
            this._client.connect(this.connectOptions);
        } else if(this.openFlag) {
            modbusSerialDebug("TcpRTUBuffered port: external socket is opened");
            callback(); // go ahead to setup existing socket
        } else {
            callback(new Error("TcpRTUBuffered port: external socket is not opened"));
        }
    }

    /**
     * Simulate successful close port.
     *
     * @param callback
     */
    close(callback) {
        this.callback = callback;
        this._client.end(callback);

        this.removeAllListeners();
    }

    /**
     * Simulate successful destroy port.
     *
     * @param callback
     */
    destroy(callback) {
        this.callback = callback;
        if (!this._client.destroyed) {
            this._client.destroy();
        }
    }

    /**
     * Send data to a modbus slave.
     *
     * @param {Buffer} data
     */
    write(data) {
        if(data.length < MIN_WRITE_DATA_LENGTH) {
            modbusSerialDebug("expected length of data is to small - minimum is " + MIN_WRITE_DATA_LENGTH);
            return;
        }

        let length = null;

        // remember current unit and command
        this._id = data[0];
        this._cmd = data[1];

        // calculate expected answer length
        switch (this._cmd) {
            case 1:
            case 2:
                length = data.readUInt16BE(4);
                this._length = 3 + parseInt((length - 1) / 8 + 1) + 2;
                break;
            case 3:
            case 4:
                length = data.readUInt16BE(4);
                this._length = 3 + 2 * length + 2;
                break;
            case 5:
            case 6:
            case 15:
            case 16:
                this._length = 6 + 2;
                break;
            case 17:
                // response is device specific
                this._length = LENGTH_UNKNOWN;
                break;
            case 43:
                // this function is super special
                // you know the format of the code response
                // and you need to continuously check that all of the data has arrived before emitting
                // see onData for more info.
                this._length = LENGTH_UNKNOWN;
                break;
            default:
                // raise and error ?
                this._length = 0;
                break;
        }

        // send buffer to slave
        this._client.write(data);

        modbusSerialDebug({
            action: "send serial rtu over tcp buffered",
            data: data,
            unitid: this._id,
            functionCode: this._cmd,
            length: this._length
        });
    }
}

/**
 * RTU buffered port for Modbus.
 *
 * @type {RTUOverTCPBufferedPort}
 */
module.exports = RTUOverTCPBufferedPort;
