require('@ideadesignmedia/config.js')
const http = require('http')
const https = require('https')
const { URL } = require('url')
const fs = require('fs')
const { request } = require('@ideadesignmedia/request')
const { Duplex } = require('stream')
const chooseProvider = protocol => protocol === 'https:' ? https : http
const maxDestinations = 10
const removedKeys = [
    'destination',
    'race',
    'proxy-auth',
    'return-error'
]
var proxyMaster = ''
const requireAuth = Boolean(process.env.AUTH)
var authOn = true
const POST = /POST/i
class BufferedStream extends Duplex {
    constructor() {
        super()
        this.setMaxListeners(maxDestinations + 1)
    }
    _read() { }
    _write(chunk, encoding, callback) {
        this.push(chunk);
        callback()
    }
    _final() {
        this.push(null)
    }
}
const fallbackLessProxy = (url, options, reqStream, returnError) => new Promise((res) => {
    const proxyReq = chooseProvider(url.protocol).request(url, { ...options, headers: { ...options.headers, host: url.host, origin: url.origin } }, async proxyRes => {
        if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400) {
            const respStream = await fallbackLessProxy(new URL(proxyRes.headers['location']), options, reqStream)
            if (respStream) {
                res(respStream)
            } else if (returnError) {
                res(respStream)
            }
        } else if (proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
            res(proxyRes)
        } else if (returnError) {
            res(respStream)
        }
    })
    proxyReq.on('error', e => {
        console.log(e)
        if (returnError) {
            res()
        }
    })
    reqStream.pipe(proxyReq)
})
const multiRequest = async (req, destination, reqStream, options, res) => {
    var responseStream
    let i = 0
    while (!responseStream && i < destination.length && i < maxDestinations) {
        let timeout
        responseStream = await new Promise((res) => {
            timeout = setTimeout(() => res(), req.headers['proxy-timeout'] || 15000)
            const url = new URL(`${destination[i]}${req.url}`)
            const proxyReq = chooseProvider(url.protocol).request(url, { ...options, headers: { ...options.headers, host: url.host, origin: url.origin } }, proxyRes => {
                const statusCode = proxyRes.statusCode
                if ((statusCode >= 200 && statusCode < 300) || i === destination.length - 1) {
                    return res(proxyRes)
                } else if (statusCode >= 300 && statusCode < 400) {
                    const location = proxyRes.headers['location']
                    if (location) {
                        destination.push(location)
                    }
                }
                res()
            })
            proxyReq.on('error', (e) => {
                console.log(e)
                res()
            })
            reqStream.pipe(proxyReq)
            i++
        }).catch(e => {
            clearTimeout(timeout)
            throw e
        })
        clearTimeout(timeout)
    }
    if (responseStream) {
        res.statusCode = responseStream.statusCode
        const keys = Object.keys(responseStream.headers)
        for (let i = 0; i < keys.length; i++) {
            res.setHeader(keys[i], responseStream.headers[keys[i]])
        }
        res.headersSent = true
        responseStream.pipe(res)
    } else {
        res.statusCode = 500
        res.setHeader('Content-Type', 'text/plain')
        res.write('Internal Server Error')
        res.headersSent = true
        res.end()
    }
}
const proxySingleRequest = async (req, res, proxyHost, options) => {
    const reqStream = new BufferedStream()
    const keys = Object.keys(req.headers)
    for (let i = 0; i < keys.length; i++) {
        if (!removedKeys.includes(keys[i])) options.headers[keys[i]] = req.headers[keys[i]]
    }
    req.pipe(reqStream)
    let responseStream, errored, i = 0
    while (!responseStream && !errored && i < maxDestinations) {
        responseStream = await new Promise((res, rej) => {
            var url = new URL(`${proxyHost}${req.url}`)
            const keys = Object.keys(req.headers)
            for (let i = 0; i < keys.length; i++) {
                if (!removedKeys.includes(keys[i])) options.headers[keys[i]] = req.headers[keys[i]]
            }
            const proxyReq = chooseProvider(url.protocol).request(url, { ...options, headers: { ...options.headers, origin: url.origin, host: url.host } }, responseStream => {
                if (responseStream.statusCode >= 300 && responseStream.statusCode < 400) {
                    const location = responseStream.headers['location']
                    if (location) {
                        proxyHost = location
                        return res()
                    }
                }
                res(responseStream)
            })
            proxyReq.on('error', e => {
                rej(e)
            })
            req.pipe(proxyReq)
        }).catch(e => {
            console.log(e)
            errored = true
        })
    }
    if (errored || !responseStream) {
        res.statusCode = 500
        res.setHeader('Content-Type', 'text/plain')
        res.write('Internal Server Error')
        res.end()
    } else {
        res.statusCode = responseStream.statusCode
        const keys = Object.keys(responseStream.headers)
        for (let i = 0; i < keys.length; i++) {
            res.setHeader(keys[i], responseStream.headers[keys[i]])
        }
        responseStream.pipe(res)
    }
}
const proxyRequest = (req, res) => {
    if (req.method === 'OPTIONS' && !req.headers['destination']) {
        res.statusCode = 200
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', '*')
        res.setHeader('Access-Control-Allow-Headers', '*')
        res.end()
        return
    }
    if (requireAuth && POST.test(req.method) && authorizedRoutes.includes(req.path)) {
        if (req.headers['proxy-auth'] !== process.env.AUTH) {
            res.statusCode = 401
            res.setHeader('Content-Type', 'text/plain')
            res.write('Unauthorized')
            return res.end()
        }
        switch (req.path) {
            case '/setProxyMaster': {
                const body = new Buffer()
                req.on('data', chunk => body.push(chunk))
                req.on('end', () => {
                    proxyMaster = body.toString('utf8')
                    res.statusCode = 200
                    res.setHeader('Content-Type', 'text/plain')
                    res.write(proxyMaster)
                    res.end()
                })
                return
            }
            case 'toggleAuth': {
                authOn = !authOn
                res.statusCode = 200
                res.setHeader('Content-Type', 'text/plain')
                res.write(authOn ? 'on' : 'off')
                res.end()
                return
            }
        }
    } else if (!req.headers['destination'] || (requireAuth && authOn && req.headers['proxy-auth'] !== process.env.AUTH)) {
        res.statusCode = 401
        res.setHeader('Content-Type', 'text/plain')
        res.write('Unauthorized')
        return res.end()
    }
    const destination = req.headers['destination'].split(', ') || proxyMaster
    if (destination.length === 0) {
        res.statusCode = 400
        res.setHeader('Content-Type', 'text/plain')
        res.write('Bad Request')
        res.end()
        return
    } else if (destination.length > 1) {
        const reqStream = new BufferedStream()
        const options = {
            headers: {},
            method: req.method
        }
        const keys = Object.keys(req.headers)
        for (let i = 0; i < keys.length; i++) {
            if (!removedKeys.includes(keys[i])) options.headers[keys[i]] = req.headers[keys[i]]
        }
        req.pipe(reqStream)
        if (req.headers['race']) {
            const proms = []
            for (let i = 0; i < destination.length; i++) {
                const url = new URL(`${destination[i]}${req.url}`)
                proms.push(fallbackLessProxy(url, options, reqStream, Boolean(req.headers['return-error'])))
            }
            const timeout = req.headers['proxy-timeout'] || 30000
            proms.push(new Promise((res, rej) => setTimeout(() => rej(new Error('Timeout')), Number.isNaN(parseInt(timeout)) ? 30000 : parseInt(timeout))))
            Promise.race(proms).then(responseStream => {
                if (responseStream) {
                    res.statusCode = responseStream.statusCode
                    const keys = Object.keys(responseStream.headers)
                    for (let i = 0; i < keys.length; i++) {
                        res.setHeader(keys[i], responseStream.headers[keys[i]])
                    }
                    res.headersSent = true
                    responseStream.pipe(res)
                } else {
                    res.statusCode = 500
                    res.setHeader('Content-Type', 'text/plain')
                    res.write('Internal Server Error')
                    res.end()
                }
            }).catch(e => {
                if (!res.headersSent) {
                    res.statusCode = 500
                    res.setHeader('Content-Type', 'text/plain')
                    res.write('Internal Server Error: ' + e.message)
                    res.end()
                }
            })
        } else {
            multiRequest(req, destination, reqStream, options, res).catch(e => {
                if (!res.headersSent) {
                    res.statusCode = 500
                    res.setHeader('Content-Type', 'text/plain')
                    res.write('Internal Server Error')
                    res.end()
                }
            })
        }
    } else {
        const proxyHost = destination[0]
        const options = {
            headers: {},
            method: req.method
        }
        proxySingleRequest(req, res, proxyHost, options)
    }
}
if (process.env.CERT_MASTER) {
    request(process.env.CERT_MASTER, { method: 'GET', headers: { 'AUTHORIZATION': "Basic " + Buffer.from(process.env.CERT_AUTH).toString('base64') } }).then(res => {
        const { cert, key } = res
        https.createServer({ cert: Buffer.from(cert, 'utf8'), key: Buffer.from(key, 'utf8') }, proxyRequest).listen(parseInt(process.env.HTTPS_PORT))
    }).catch(e => {
        console.log('error', e)
    })
} else if (process.env.CERT && process.env.KEY) {
    https.createServer({ cert: fs.readFileSync(process.env.CERT), key: fs.readFileSync(process.env.KEY) }, proxyRequest).listen(parseInt(process.env.HTTPS_PORT))
}
http.createServer(proxyRequest).listen(parseInt(process.env.PORT))