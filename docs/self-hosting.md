# Running Roer on a server

`roer-server` is the backend the desktop app embeds, served over HTTP and a
WebSocket, with the frontend built in. Run it on a machine you own and use
Roer from a browser tab: the terminals, agents, repositories and logins all
live on that machine.

## The image

```sh
docker build -t roer-server .

# The token, in a file only you can read rather than on a command line,
# where shell history and `ps` would keep it.
umask 077
echo "ROER_SERVER_TOKEN=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')" > ~/.roer-server.env

docker run -d --name roer --restart unless-stopped \
  -p 127.0.0.1:4317:4317 \
  -v roer-home:/home/roer \
  --env-file ~/.roer-server.env \
  roer-server
docker logs roer
```

The log prints a `…/api/session?token=…` URL. Open it once per browser: it
trades the token for a cookie, and every later visit needs only the address.
Without `ROER_SERVER_TOKEN` a new token is made on every start, and every
browser has to open the new URL. To shut every browser out, write a new
token to the file and re-create the container.

The server takes the token out of its environment as it starts, so the
terminals and agents it runs never see it. `docker exec` shells and
`docker inspect` still do: Docker gives them the container's environment,
but whoever can run those already controls the machine. Processes in the
container can still read the server's starting environment under `/proc`,
though; on a server others can reach, give it only the token's hash (below).

The image holds `roer-server`, the `roer` command, tmux, git, gh and Claude
Code, running as the user `roer`. `/home/roer` is the one volume: projects,
Roer's own state, and the Claude, gh and git logins live there, so a new
image keeps them. A restart does end the running sessions, as quitting the
desktop app does.

Log in once from a shell in the container:

```sh
docker exec -it roer bash
claude            # then /login
gh auth login
git config --global user.name "…"; git config --global user.email "…"
git clone … ~/projects/…
```

## Settings

| Variable | Default | |
|---|---|---|
| `ROER_SERVER_HOST` | `127.0.0.1` (`0.0.0.0` in the image) | interface to listen on |
| `ROER_SERVER_PORT` | `4317` | |
| `ROER_SERVER_PUBLIC_URL` | the bind address | the address browsers use, e.g. `https://roer.example.com` behind a proxy |
| `ROER_SERVER_TOKEN` | a new one per start | 32 or more of `A-Za-z0-9-_` |
| `ROER_SERVER_TOKEN_SHA256` | | in place of the token, its SHA-256 in hex |

## On a cloud server

Anyone with the token gets a shell on the server, so the server must be
reached only over a private network or TLS. It speaks plain HTTP only.

Over SSH, with nothing open but SSH: publish the port on `127.0.0.1` as
above, then from your own machine run `ssh -L 4317:localhost:4317 you@server`
and open `http://localhost:4317/api/session?token=…`.

With a domain name, put Caddy in front, which gets a certificate on its own
and forwards `Host` and `X-Forwarded-Proto` as Roer expects:

```
# /etc/caddy/Caddyfile
roer.example.com {
	reverse_proxy 127.0.0.1:4317
}
```

and add `ROER_SERVER_PUBLIC_URL=https://roer.example.com` to the env file.
Only ports 22, 80 and 443 need to be open in the firewall.

### Keeping only the token's hash

The terminals and agents in Roer run as the same user as the server, so
they can read what it was started with. Give it the token's SHA-256 instead
of the token, and nothing on the server logs anyone in:

```sh
token=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')
echo "$token"   # keep it, in a password manager: the server cannot tell you
umask 077
echo "ROER_SERVER_TOKEN_SHA256=$(printf %s "$token" | shasum -a 256 | cut -d' ' -f1)" > ~/.roer-server.env
```

The log then prints the link as `…/api/session?token=<your token>`, for you
to fill in. A lost token cannot be had back from the server: make a new one,
write its hash to the file, and re-create the container.

## More than one person

One server is one person's Roer: everyone who has the token shares the same
Linux user, the same sessions, and the same Claude and GitHub logins. For
several people, run one container each, with its own volume, port, token and
address (`alice.roer.example.com` → `127.0.0.1:4318`, and so on).

Not in the browser: the OS folder picker (an in-page one takes its place),
desktop notifications, and moving a terminal session into Roer.
