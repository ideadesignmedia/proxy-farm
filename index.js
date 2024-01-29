require('@ideadesignmedia/config.js')
const http = require('http')
const https = require('https')
const {URL} = require('url')
const fs = require('fs')
const {request} = require('@ideadesignmedia/request')
const chooseProvider = protocol => protocol === 'https:' ? https : http
const removedKeys = [
    'host',
    'connection',
    'origin',
    'destination'
]
var proxyMaster = ''
const proxyRequest = (req, res) => {
    if (/POST/i.test(req.method) && req.path === '/setProxyMaster') {
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
    const proxyHost = req.headers['destination'] || proxyMaster
    if (!proxyHost) {
        res.statusCode = 500
        res.setHeader('Content-Type', 'text/plain')
        res.write('Internal Server Error')
        res.end()
        return
    }
    const options = {
        headers: {},
        method: req.method
    }
    const keys = Object.keys(req.headers)
    for (let i = 0; i < keys.length; i++) {
        if (!removedKeys.includes(keys[i])) options.headers[keys[i]] = req.headers[keys[i]]
    }
    const url = new URL(`${proxyHost}${req.url}`)
    const proxyReq = chooseProvider(url.protocol).request(url, options, responseStream => {
        res.statusCode = responseStream.statusCode
        const keys = Object.keys(responseStream.headers)
        for (let i = 0; i < keys.length; i++) {
            res.setHeader(keys[i], responseStream.headers[keys[i]])
        }
        responseStream.pipe(res)
    })
    proxyReq.on('error', e => {
        console.log('error', e)
        res.statusCode = 500
        res.setHeader('Content-Type', 'text/plain')
        res.write('Internal Server Error')
        res.end()
    })
    req.pipe(proxyReq)
}
if (process.env.CERT_MASTER) {
    request(process.env.CERT_MASTER, {method: 'GET', headers: {'AUTHORIZATION': "Basic " + Buffer.from(process.env.CERT_AUTH).toString('base64')}}).then(res => {
        const {cert, key} = res
        https.createServer({cert: Buffer.from(cert, 'utf8'), key: Buffer.from(key, 'utf8')}, proxyRequest).listen(parseInt(process.env.HTTPS_PORT))
    }).catch(e => {
        console.log('error', e)
    })
} else if (process.env.CERT && process.env.KEY) {
    https.createServer({cert: fs.readFileSync(process.env.CERT), key: fs.readFileSync(process.env.KEY)}, proxyRequest).listen(parseInt(process.env.HTTPS_PORT))
}
http.createServer(proxyRequest).listen(parseInt(process.env.PORT))