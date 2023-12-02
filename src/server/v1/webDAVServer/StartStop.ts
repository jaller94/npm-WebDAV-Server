import { HTTPCodes, MethodCallArgs, WebDAVRequest } from '../WebDAVRequest'
import { WebDAVServerStartCallback } from './Types'
import { Writable, Readable } from 'node:stream'
import { Errors, HTTPError } from '../../../Errors'
import { WebDAVServer } from './WebDAVServer'
import { IAutoSave } from '../WebDAVServerOptions'
import * as https from 'node:https'
import * as http from 'node:http'
import * as zlib from 'node:zlib'
import * as fs from 'node:fs'

function autoSave(options : IAutoSave)
{
    if(!options.streamProvider)
        options.streamProvider = (s, cb) => cb(s);
    if(!options.onSaveError)
        options.onSaveError = () => {};

    let saving = false;
    let saveRequested = false;
    this.afterRequest((arg : MethodCallArgs, next) => {
        switch(arg.request.method.toUpperCase())
        {
            case 'PROPPATCH':
            case 'DELETE':
            case 'MKCOL':
            case 'MOVE':
            case 'COPY':
            case 'POST':
            case 'PUT':
                // Avoid concurrent saving
                if(saving)
                {
                    saveRequested = true;
                    next();
                    return;
                }

                const save = function()
                {
                    this.save((e, data) => {
                        if(e)
                        {
                            options.onSaveError(e);
                            next();
                        }
                        else
                        {
                            const stream = zlib.createGzip();
                            options.streamProvider(stream, (outputStream) => {
                                if(!outputStream)
                                    outputStream = stream;
                                outputStream.pipe(fs.createWriteStream(options.tempTreeFilePath));

                                stream.on('error', (e) => {
                                    if(e)
                                    {
                                        options.onSaveError(e);
                                        next();
                                        return;
                                    }
                                });

                                stream.end(JSON.stringify(data));

                                stream.on('close', () => {
                                    fs.unlink(options.treeFilePath, (e) => {
                                        if(e && e.code !== 'ENOENT') // An error other than ENOENT (no file/folder found)
                                        {
                                            options.onSaveError(e);
                                            next();
                                            return;
                                        }

                                        fs.rename(options.tempTreeFilePath, options.treeFilePath, (e) => {
                                            if(e)
                                                options.onSaveError(e);
                                            next();
                                        })
                                    })
                                })
                            })
                        }
                    })
                }

                saving = true;
                next = () => {
                    if(saveRequested)
                    {
                        saveRequested = false;
                        save.bind(this)();
                    }
                    else
                        saving = false;
                }
                save.bind(this)();
                break;
            
            default:
                next();
                break;
        }
    })
}

export function start(port ?: number | WebDAVServerStartCallback, callback ?: WebDAVServerStartCallback)
{
    let _port : number = this.options.port;
    let _callback : WebDAVServerStartCallback;

    if(port && port.constructor === Number)
    {
        _port = port as number;
        if(callback)
        {
            if(callback instanceof Function)
                _callback = callback;
            else
                throw Errors.IllegalArguments;
        }
    }
    else if(port && port.constructor === Function)
    {
        _port = this.options.port;
        _callback = port as WebDAVServerStartCallback;
        if(callback)
            throw Errors.IllegalArguments;
    }

    if(!this.server)
    {
        const serverCreator = this.options.https ? (c) => https.createServer(this.options.https, c) : (c) => http.createServer(c);
        this.server = serverCreator((req : http.IncomingMessage, res : http.ServerResponse) =>
        {
            let method : WebDAVRequest = this.methods[this.normalizeMethodName(req.method)];
            if(!method)
                method = this.unknownMethod;

            MethodCallArgs.create(this, req, res, (e, base) => {
                if(e)
                {
                    if(e === Errors.AuenticationPropertyMissing || e === Errors.MissingAuthorisationHeader || e === Errors.BadAuthentication || e === Errors.WrongHeaderFormat)
                        base.setCode(HTTPCodes.Unauthorized);
                    else
                        base.setCode(HTTPCodes.InternalServerError);
                    res.end();
                    return;
                }

                base.exit = () =>
                {
                    base.response.end();
                    this.invokeAfterRequest(base, null);
                };

                if(!this.options.canChunk || !method.chunked)
                {
                    const go = () =>
                    {
                        this.invokeBeforeRequest(base, () => {
                            method(base, base.exit);
                        })
                    }

                    if(base.contentLength <= 0)
                    {
                        base.data = Buffer.alloc(0);
                        go();
                    }
                    else
                    {
                        const data = Buffer.alloc(base.contentLength);
                        let index = 0;
                        req.on('data', (chunk) => {
                            if(chunk.constructor === String)
                                chunk = Buffer.from(chunk as string);
                            
                            for(let i = 0; i < chunk.length && index < data.length; ++i, ++index)
                                data[index] = (chunk as Buffer)[i];
                            
                            if(index >= base.contentLength)
                            {
                                base.data = data;
                                go();
                            }
                        });
                    }
                }
                else
                {
                    this.invokeBeforeRequest(base, () => {
                        method.chunked(base, base.exit);
                    })
                }
            })
        })

        if(this.options.autoSave)
            autoSave.bind(this)(this.options.autoSave);
    }

    this.server.listen(_port, this.options.hostname, () => {
        if(_callback)
            _callback(this.server);
    });
}

export function stop(callback : () => void)
{
    if(this.server)
    {
        this.server.close(callback);
        this.server = null;
    }
    else
        process.nextTick(callback);
}
