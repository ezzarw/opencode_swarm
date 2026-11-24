/**
 * OpenCode Swarm RPC Contract (`id: "swarm"`).
 * Uses plain JSON Schema objects so it has zero external runtime dependencies
 * while remaining 100% compatible with `@opencode/plugin` `Rpc.PortableDefinition`.
 */

function defineRpc<const D extends {
  readonly id: string
  readonly methods: Record<string, { readonly input: unknown; readonly output: unknown; readonly errors?: Record<string, unknown> }>
  readonly events: Record<string, { readonly schema: { readonly type: "object"; readonly [k: string]: unknown } }>
}>(definition: D): D {
  for (const method of Object.values(definition.methods)) {
    for (const errName of Object.keys(method.errors ?? {})) {
      if (errName.startsWith("rpc.")) {
        throw new Error(`RPC error names starting with "rpc." are reserved: ${errName}`)
      }
    }
  }
  return definition
}

const errorSchema = {
  type: "object",
  properties: {
    reason: { type: "string" },
  },
  additionalProperties: true,
} as const

export const SwarmRpc = defineRpc({
  id: "swarm",
  methods: {
    snapshot: {
      input: {
        type: "object",
        properties: {
          swarmId: { type: "string" },
          etag: { type: "string" },
        },
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          etag: { type: "string" },
          changed: { type: "boolean" },
          snapshot: { type: "object", additionalProperties: true },
        },
        required: ["etag", "changed"],
        additionalProperties: false,
      },
      errors: {
        not_found: errorSchema,
      },
    },
    dm: {
      input: {
        type: "object",
        properties: {
          swarmId: { type: "string" },
          to: { type: "string" },
          text: { type: "string" },
          channel: { type: "string" },
          from: { type: "string" },
        },
        required: ["text"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          seq: { type: "number" },
          time: { type: "string" },
          channel: { type: "string" },
        },
        required: ["seq", "time", "channel"],
        additionalProperties: false,
      },
      errors: {
        invalid_input: errorSchema,
      },
    },
    model: {
      input: {
        type: "object",
        properties: {
          swarmId: { type: "string" },
          name: { type: "string" },
          model: { type: "string" },
          provider: { type: "string" },
        },
        required: ["name", "model"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          name: { type: "string" },
          model: { type: "string" },
          provider: { type: "string" },
        },
        required: ["ok", "name", "model"],
        additionalProperties: false,
      },
      errors: {
        not_found: errorSchema,
      },
    },
    land: {
      input: {
        type: "object",
        properties: {
          swarmId: { type: "string" },
          name: { type: "string" },
          verifierApproved: { type: "boolean" },
        },
        required: ["name"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          reason: { type: "string" },
          mergedBranch: { type: "string" },
        },
        required: ["ok"],
        additionalProperties: false,
      },
      errors: {
        not_found: errorSchema,
        conflict: errorSchema,
        verifier_required: errorSchema,
      },
    },
    channel: {
      input: {
        type: "object",
        properties: {
          swarmId: { type: "string" },
          action: { type: "string", enum: ["create", "archive", "subscribe", "unsubscribe", "list"] },
          channel: { type: "string" },
          member: { type: "string" },
        },
        required: ["action"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          channels: { type: "array", items: { type: "object", additionalProperties: true } },
        },
        required: ["ok"],
        additionalProperties: false,
      },
      errors: {
        invalid_input: errorSchema,
      },
    },
    kill: {
      input: {
        type: "object",
        properties: {
          swarmId: { type: "string" },
          name: { type: "string" },
          force: { type: "boolean" },
        },
        required: ["name"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          name: { type: "string" },
        },
        required: ["ok", "name"],
        additionalProperties: false,
      },
      errors: {
        not_found: errorSchema,
        dirty_worktree: errorSchema,
      },
    },
    models: {
      input: {
        type: "object",
        properties: {
          swarmId: { type: "string" },
        },
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          models: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                provider: { type: "string" },
                name: { type: "string" },
              },
              required: ["id"],
              additionalProperties: true,
            },
          },
        },
        required: ["models"],
        additionalProperties: false,
      },
    },
    swarms: {
      input: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          swarms: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                title: { type: "string" },
                head: { type: "number" },
                memberCount: { type: "number" },
              },
              required: ["id", "head", "memberCount"],
              additionalProperties: true,
            },
          },
        },
        required: ["swarms"],
        additionalProperties: false,
      },
    },
  },
  events: {
    updated: {
      schema: {
        type: "object",
        properties: {
          swarmId: { type: "string" },
          etag: { type: "string" },
          head: { type: "number" },
          reason: { type: "string" },
        },
        required: ["swarmId", "etag", "head"],
        additionalProperties: false,
      },
    },
  },
})

export type SwarmRpcDefinition = typeof SwarmRpc

export interface RpcModelInfo {
  id: string
  provider?: string
  name?: string
}

export interface RpcSwarmSummary {
  id: string
  title?: string
  head: number
  memberCount: number
}
