# EchoLink Adapter

EchoLink Adapter is a Hermes Agent platform plugin that connects Hermes to the
`hermes-echolink` custom IM server.

## Layout

```text
hermes-plugin/echolink-adapter/
  PLUGIN.yaml
  adapter.py
  README.md
```

## Install During Development

Keep the source in this repository and symlink it into Hermes' plugin folder:

```bash
mkdir -p ~/.hermes/plugins
ln -s /Users/waton/Projects/Mine/hermes-echolink/hermes-plugin/echolink-adapter \
  ~/.hermes/plugins/echolink-adapter
```

## Environment

```bash
export ECHOLINK_TOKEN=dev-token
export ECHOLINK_BASE_URL=http://127.0.0.1:8787
export ECHOLINK_BOT_ID=hermes
export ECHOLINK_BOT_NAME=Hermes
```

`ECHOLINK_GATEWAY_URL` is optional. If omitted, the adapter derives it from
`ECHOLINK_BASE_URL`:

```text
ws://127.0.0.1:8787/v1/gateway/connect
```

## Protocol

Inbound user messages arrive from EchoLink over WebSocket as `message.created`
events. The adapter maps those events to Hermes `MessageEvent` objects and calls
`handle_message()`.

Outbound Hermes replies call EchoLink:

```text
POST /v1/messages
Authorization: Bearer <ECHOLINK_TOKEN>
```

The first version supports text messages only.

