These factual fixtures were produced by running the adjacent original test
harnesses against the official Minecraft client classes, with the runtime
libraries declared in each official launcher manifest. No Minecraft JARs,
libraries, mappings, assets, or decompiled source are included here.

`BundleNativeProof.java` invokes `BundleContents.CODEC` with native
`HashOps.CRC32C_INSTANCE` and separately invokes `BundleContents.STREAM_CODEC`.
The JSON records those independent results. The 1.21.11 official obfuscated JAR
was remapped using its official client mappings before running the harness;
both its original and mapped SHA-1 values are recorded. The 26.1 official JAR
already contains named classes and requires Java 25.

To reproduce, compile the appropriate harness against that version's named
client JAR and manifest libraries, then run it on the same classpath. The class
directory must not contain an unrelated `version.json`, because the game loads
that resource from its classpath. The harness contains the full item/count/patch
inputs; the JSON contains no values inferred from the JavaScript implementation.

The raw stream data includes empty contents, nested component patches, removals,
an overridden maximum stack size, item IDs on both sides of the 127/128 VarInt
boundary, and counts 1 through 99. For 26.1, invalid air/zero-count templates
also record the native byte position before rejection and the next sentinel.

`bundle-inventory.test.mjs` requires exact decoding consumption and exact
re-encoding of these official bytes. `bundle-inventory.browser.mjs` drives actual
DOM clicks/wheel events through a WebSocket fixture and the real protocol codec.
That fixture accepts only the independent native component hashes and sends no
inventory echo or correction for accepted clicks. It is a strict protocol server
fixture, rather than a claim that an external server's bundle implementation
is complete.
