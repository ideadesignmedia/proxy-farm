require('@ideadesignmedia/config.js')
const app = require('express').Router()
const fs = require('fs')
app.get('/', (req, res) => {
    const auth = req.headers['authorization']?.split(' ')[1]
    if (!auth) return res.status(401).json({error: true, message: 'No authorization header'})
    if (!Buffer.from(auth, 'base64').toString('utf8') === process.env.CERT_AUTH) return res.status(401).json({error: true, message: 'Invalid authorization header'})
    try {
        const cert = fs.readFileSync(process.env.CERT || '/etc/letsencrypt/live/proxy.ideadesignmedia.com/fullchain.pem')
        const key = fs.readFileSync(process.env.KEY || '/etc/letsencrypt/live/proxy.ideadesignmedia.com/privkey.pem')
        res.status(200).json({cert, key})
    } catch(e) {
        console.error(e)
        res.status(500).json({error: true, message: 'Internal Server Error'})
    }
})
require('@ideadesignmedia/webserver.js')({
    httpPort: process.env.PORT,
    port: process.env.HTTPS_PORT,
    cert: process.env.CERT,
    key: process.env.KEY
}, app)