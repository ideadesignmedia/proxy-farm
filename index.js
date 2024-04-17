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
const fallbackLessProxy = (url, options, reqStream, returnError, respond) => {
    let killed = false
    let proxyReq
    const createRequest = (location) => {
        const url = new URL(location)
        proxyReq = chooseProvider(url.protocol).request(url, { ...options, headers: { ...options.headers, host: url.host, origin: url.origin } }, handleResponse)
        proxyReq.on('error', e => {
            if (returnError) {
                console.error(e)
                respond()
            }
        })
        reqStream.pipe(proxyReq)
    }
    const handleResponse = proxyRes => {
        if (killed) return
        if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers['location']) {
            createRequest(proxyRes.headers['location'])
        } else if ((proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) || returnError) {
            respond(proxyRes)
        }
    }
    createRequest(url)
    return () => {
        killed = true
        proxyReq.destroy()
    }
}
const race = (req, reqStream, destination, options, res) => {
    const timeout = req.headers['proxy-timeout'] || 60000
    const streams = {}
    const cancelOthers = (index) => {
        for (let i = 0; i < destination.length; i++) {
            if (i !== index && streams[i]) {
                streams[i]()
            }
        }
    }
    const t = () => {
        if (!res.headersSent) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'text/plain')
            res.write('Timeout')
            res.end()
        }
        for (let i = 0; i < destination.length; i++) {
            if (streams[i]) {
                streams[i]()
            }
        }
    }
    const endOnTimeout = setTimeout(() => t(), Number.isNaN(parseInt(timeout)) ? 30000 : parseInt(timeout))
    const respond = (index, stream) => {
        clearTimeout(endOnTimeout)
        try {
            cancelOthers(index)
        } catch { }
        res.headersSent = true
        res.statusCode = stream.statusCode
        const keys = Object.keys(stream.headers)
        for (let i = 0; i < keys.length; i++) {
            res.setHeader(keys[i], stream.headers[keys[i]])
        }
        stream.pipe(res)
    }
    for (let i = 0; i < destination.length; i++) streams[i] = fallbackLessProxy(new URL(`${destination[i]}${req.url}`), options, reqStream, Boolean(req.headers['return-error']), (stream) => respond(i, stream))
}
const multiRequest = async (req, destination, reqStream, options, res) => {
    var responseStream
    let i = 0, errored
    while (!responseStream && i < destination.length && i < maxDestinations) {
        let timeout
        responseStream = await new Promise((res) => {
            timeout = setTimeout(() => res('timed-out'), req.headers['proxy-timeout'] || 15000)
            const url = new URL(`${destination[i]}${req.url}`)
            const proxyReq = chooseProvider(url.protocol).request(url, { ...options, headers: { ...options.headers, host: url.host, origin: url.origin } }, proxyRes => {
                const statusCode = proxyRes.statusCode
                if ((statusCode >= 200 && statusCode < 300) || i === destination.length - 1) {
                    return res(proxyRes)
                } else if (statusCode >= 300 && statusCode < 400 && proxyRes.headers['location']) {
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
            errored = i === destination.length - 1
            if (errored) {
                console.log(e)
            }
        })
        if (responseStream === 'timed-out' && i !== destination.length - 1) {
            responseStream = null
        } else {
            clearTimeout(timeout)
        }
    }
    if (errored || !responseStream) {
        res.statusCode = 500
        res.setHeader('Content-Type', 'text/plain')
        res.write('Internal Server Error')
        res.end()
    } else if (responseStream === 'timed-out') {
        res.statusCode = 504
        res.setHeader('Content-Type', 'text/plain')
        res.write('Gateway Timeout')
        res.end()
    } else {
        res.statusCode = responseStream.statusCode
        const keys = Object.keys(responseStream.headers)
        for (let i = 0; i < keys.length; i++) {
            res.setHeader(keys[i], responseStream.headers[keys[i]])
        }
        res.headersSent = true
        responseStream.pipe(res)
    }
}
const proxySingleRequest = async (req, reqStream, res, proxyHost, options) => {
    let responseStream, errored, i = 0
    while (!responseStream && !errored && i < maxDestinations) {
        let timeout
        responseStream = await new Promise((res, rej) => {
            timeout = setTimeout(() => res('timed-out'), req.headers['proxy-timeout'] || 15000)
            var url = new URL(`${proxyHost}${req.url}`)
            const keys = Object.keys(req.headers)
            for (let i = 0; i < keys.length; i++) {
                if (!removedKeys.includes(keys[i])) options.headers[keys[i]] = req.headers[keys[i]]
            }
            const proxyReq = chooseProvider(url.protocol).request(url, { ...options, headers: { ...options.headers, origin: url.origin, host: url.host } }, responseStream => {
                if (responseStream.statusCode >= 300 && responseStream.statusCode < 400 && responseStream.headers['location']) {
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
            reqStream.pipe(proxyReq)
        }).catch(e => {
            console.log(e)
            errored = true
        })
        clearTimeout(timeout)
    }
    if (errored || !responseStream) {
        res.headersSent = true
        res.statusCode = 500
        res.setHeader('Content-Type', 'text/plain')
        res.write('Internal Server Error')
        res.end()
    } else if (responseStream === 'timed-out') {
        res.headersSent = true
        res.statusCode = 504
        res.setHeader('Content-Type', 'text/plain')
        res.write('Gateway Timeout')
        res.end()
    } else {
        res.headersSent = true
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
    }
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
    if (destination.length > 1) {
        if (req.headers['race']) {
            try {
                race(req, reqStream, destination, options, res)
            } catch (e) {
                console.error(e)
                if (!res.headersSent) {
                    res.statusCode = 500
                    res.setHeader('Content-Type', 'text/plain')
                    res.write('Internal Server Error')
                    res.end()
                }
            }
        } else {
            multiRequest(req, destination, reqStream, options, res).catch(e => {
                console.error(e)
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
        proxySingleRequest(req, reqStream, res, proxyHost, options).catch(e => {
            console.error(e)
            if (!res.headersSent) {
                res.statusCode = 500
                res.setHeader('Content-Type', 'text/plain')
                res.write('Internal Server Error')
                res.end()
            }
        })
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
process.on('unhandledRejection', e => {
    console.error(e)
})
process.on('uncaughtException', e => {
    console.error(e)
})
http.createServer(proxyRequest).listen(parseInt(process.env.PORT))