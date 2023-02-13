// Copyright (c) 2023 Jose-Luis Landabaso - https://bitcoinerlab.com
// Distributed under the MIT software license

import { compileMiniscript, satisfier } from '@bitcoinerlab/miniscript';
import {
  address,
  networks,
  payments,
  script as bscript,
  crypto,
  Network,
  Payment,
  Transaction,
  PsbtTxInput,
  Psbt
} from 'bitcoinjs-lib';
import type { PsbtInput, Bip32Derivation } from 'bip174/src/lib/interfaces';
const { p2sh, p2wpkh, p2pkh, p2pk, p2wsh } = payments;
import type { PartialSig } from 'bip174/src/lib/interfaces';

import type { TinySecp256k1Interface } from './tinysecp';

import { /*FinalScriptsFunc,*/ finalScriptsFuncFactory } from './psbt';

import { BIP32Factory, BIP32API } from 'bip32';
import { ECPairFactory, ECPairAPI } from 'ecpair';

import { DescriptorChecksum } from './checksum';

import { numberEncodeAsm } from './numberEncodeAsm';

import {
  parseKeyExpression as globalParseKeyExpression,
  KeyExpression
} from './keyExpressions';

import * as RE from './re';

interface PsbtInputExtended extends PsbtInput, PsbtTxInput {}

export interface Preimage {
  digest: string; //Use same expressions as in miniscript. For example: "sha256(cdabb7f2dce7bfbd8a0b9570c6fd1e712e5d64045e9d6b517b3d5072251dc204)" or "ripemd160(095ff41131e5946f3c85f79e44adbcf8e27e080e)"
  //Accepted functions: sha256, hash256, ripemd160, hash160
  // 64-character HEX for sha256, hash160 or 30-character HEX for ripemd160 or hash160
  preimage: string; //Preimages are always 32 bytes (64 character in hex)
}

//See "Resource limitations" https://bitcoin.sipa.be/miniscript/
//https://lists.linuxfoundation.org/pipermail/bitcoin-dev/2019-September/017306.html
const MAX_SCRIPT_ELEMENT_SIZE = 520;
const MAX_STANDARD_P2WSH_SCRIPT_SIZE = 3600;
const MAX_OPS_PER_SCRIPT = 201;

/*
 * Returns a bare descriptor without checksum and particularized for a certain
 * index (if desc was a range descriptor)
 */
function isolate({
  expression,
  checksumRequired,
  index
}: {
  expression: string;
  checksumRequired: boolean;
  index: number;
}): string {
  const mChecksum = expression.match(String.raw`(${RE.reChecksum})$`);
  if (mChecksum === null && checksumRequired === true)
    throw new Error(`Error: descriptor ${expression} has not checksum`);
  //isolatedExpression: a bare desc without checksum and particularized for a certain
  //index (if desc was a range descriptor)
  let isolatedExpression = expression;
  if (mChecksum !== null) {
    const checksum = mChecksum[0].substring(1); //remove the leading #
    isolatedExpression = expression.substring(
      0,
      expression.length - mChecksum[0].length
    );
    if (checksum !== DescriptorChecksum(isolatedExpression)) {
      throw new Error(`Error: invalid descriptor checksum for ${expression}`);
    }
  }
  let mWildcard = isolatedExpression.match(/\*/g);
  if (mWildcard && mWildcard.length > 0) {
    if (!Number.isInteger(index) || index < 0)
      throw new Error(`Error: invalid index ${index}`);
    //From  https://github.com/bitcoin/bitcoin/blob/master/doc/descriptors.md
    //To prevent a combinatorial explosion of the search space, if more than
    //one of the multi() key arguments is a BIP32 wildcard path ending in /* or
    //*', the multi() expression only matches multisig scripts with the ith
    //child key from each wildcard path in lockstep, rather than scripts with
    //any combination of child keys from each wildcard path.

    //We extend this reasoning for musig for all cases
    isolatedExpression = isolatedExpression.replaceAll('*', index.toString());
  }
  return isolatedExpression;
}

interface ParseKeyExpression {
  (params: {
    keyExpression: string;
    network?: Network;
    isSegwit?: boolean;
  }): KeyExpression;
}

interface ExpansionMap {
  [key: string]: KeyExpression;
}
//TODO: Do a proper declaration interface DescriptorInterface or API...
export interface DescriptorInterface {
  //getPayment(): any;
  //getAddress(): string;
  //getScriptPubKey(): any;
  //getScriptSatisfaction(signatures: any[]): Buffer;
  // ... add the rest of the methods and properties as required
}

/**
 * Builds the functions needed to operate with descriptors using an external elliptic curve (ecc) library.
 * @param {Object} ecc - an object containing elliptic curve operations, such as [tiny-secp256k1](https://github.com/bitcoinjs/tiny-secp256k1) or [@bitcoinerlab/secp256k1](https://github.com/bitcoinerlab/secp256k1).
 * @returns {Object} an object containing functions, `parse` and `checksum`.
 * @namespace
 */
export function DescriptorsFactory(ecc: TinySecp256k1Interface): {
  Descriptor: DescriptorInterface;
  ECPair: ECPairAPI;
  parseKeyExpression: ParseKeyExpression;
  BIP32: BIP32API;
} {
  const BIP32: BIP32API = BIP32Factory(ecc);
  const ECPair: ECPairAPI = ECPairFactory(ecc);

  /*
   * Takes a string key expression (xpub, xprv, pubkey or wif) and parses it
   */
  function parseKeyExpression({
    keyExpression,
    network = networks.bitcoin,
    isSegwit = true
  }: {
    keyExpression: string;
    network?: Network;
    isSegwit?: boolean;
  }): KeyExpression {
    return globalParseKeyExpression({
      keyExpression,
      network,
      isSegwit,
      ECPair,
      BIP32
    });
  }

  //TODO: refactor - move from here
  function countNonPushOnlyOPs(script: Buffer): number {
    const decompile = bscript.decompile(script);
    if (!decompile) throw new Error(`Error: cound not decompile ${script}`);
    return decompile.filter(op => op > bscript.OPS['OP_16']!).length;
  }

  /**
   * Expand a miniscript to a generalized form using variables instead of key
   * expressions. Variables will be of this form: @0, @1, ...
   * This is done so that it can be compiled with compileMiniscript and
   * satisfied with satisfier.
   * Also compute pubkeys from descriptors to use them later.
   */
  function expandMiniscript({
    miniscript,
    isSegwit = true,
    network = networks.bitcoin
  }: {
    miniscript: string;
    isSegwit?: boolean;
    network?: Network;
  }): {
    expandedMiniscript: string;
    expansionMap: ExpansionMap;
  } {
    const expansionMap: ExpansionMap = {};
    const expandedMiniscript = miniscript.replace(
      RegExp(RE.reKeyExp, 'g'),
      (keyExpression: string) => {
        const key = '@' + Object.keys(expansionMap).length;
        expansionMap[key] = parseKeyExpression({
          keyExpression,
          isSegwit,
          network
        });
        return key;
      }
    );
    const pubkeys = Object.values(expansionMap);
    if (new Set(pubkeys).size !== pubkeys.length) {
      throw new Error(
        `Error: miniscript ${miniscript} is not sane: contains duplicate public keys.`
      );
    }
    return { expandedMiniscript, expansionMap };
  }

  /**
   * Particularize an expanded ASM expression using the variables in
   * expansionMap.
   * This is the kind of the opposite to what expandMiniscript does.
   * Signatures and preimages are already subsituted by the satisfier calling
   * this function.
   */
  function substituteAsm({
    expandedAsm,
    expansionMap
  }: {
    expandedAsm: string;
    expansionMap: ExpansionMap;
  }): string {
    //Replace back variables into the pubkeys previously computed.
    let asm = Object.keys(expansionMap).reduce((accAsm, key) => {
      const pubkey = expansionMap[key]?.pubkey;
      if (!pubkey) {
        throw new Error(`Error: invalid expansionMap for ${key}`);
      }
      return accAsm
        .replaceAll(`<${key}>`, `<${pubkey.toString('hex')}>`)
        .replaceAll(
          `<HASH160\(${key}\)>`,
          `<${crypto.hash160(pubkey).toString('hex')}>`
        );
    }, expandedAsm);

    //Now clean it and prepare it so that fromASM can be called:
    asm = asm
      .trim()
      //Replace one or more consecutive whitespace characters (spaces, tabs,
      //or line breaks) with a single space.
      .replace(/\s+/g, ' ')
      //Now encode numbers to little endian hex. Note that numbers are not
      //enclosed in <>, since <> represents hex code already encoded.
      //The regex below will match one or more digits within a string,
      //except if the sequence is surrounded by "<" and ">"
      .replace(/(?<![<])\b\d+\b(?![>])/g, (num: string) =>
        numberEncodeAsm(Number(num))
      )
      //we don't have numbers anymore, now it's safe to remove < and > since we
      //know that every remaining is either an op_code or a hex encoded number
      .replace(/[<>]/g, '');

    return asm;
  }

  //TODO: refactor - move from here
  function miniscript2Script({
    miniscript,
    isSegwit = true,
    network = networks.bitcoin
  }: {
    miniscript: string;
    isSegwit?: boolean;
    network?: Network;
  }): Buffer {
    const { expandedMiniscript, expansionMap } = expandMiniscript({
      miniscript,
      isSegwit,
      network
    });
    const compiled = compileMiniscript(expandedMiniscript);
    if (compiled.issane !== true) {
      throw new Error(`Error: Miniscript ${expandedMiniscript} is not sane`);
    }
    return bscript.fromASM(
      substituteAsm({ expandedAsm: compiled.asm, expansionMap })
    );
  }

  //TODO: refactor - move from here
  /**
   * Assumptions:
   * The attacker does not have access to any of the private keys of public keys that participate in the Script.
   * The attacker only has access to hash preimages that honest users have access to as well.
   *
   * Pass constraints to search for the first solution with this nLockTime and nSequence.
   * Don't pass constraints (this is the default) if you want to get the smallest size solution altogether.
   *
   * It a solution is not found this function throws.
   */
  function satisfyMiniscript({
    miniscript,
    isSegwit = true,
    signatures = [],
    preimages = [],
    constraints,
    network = networks.bitcoin
  }: {
    miniscript: string;
    isSegwit?: boolean;
    signatures?: PartialSig[];
    preimages?: Preimage[];
    constraints?:
      | { nLockTime: number | undefined; nSequence: number | undefined }
      | undefined;
    network?: Network;
  }): {
    scriptSatisfaction: Buffer | undefined;
    nLockTime: number | undefined;
    nSequence: number | undefined;
  } {
    const { expandedMiniscript, expansionMap } = expandMiniscript({
      miniscript,
      isSegwit,
      network
    });

    //convert 'sha256(6c...33)' to: { ['<sha256_preimage(6c...33)>']: '10...5f'}
    let preimageMap: { [key: string]: string } = {};
    preimages.forEach(preimage => {
      preimageMap['<' + preimage.digest.replace('(', '_preimage(') + '>'] =
        '<' + preimage.preimage + '>';
    });

    //convert the pubkeys in signatures into [{['<sig(@0)>']: '30450221'}, ...]
    //get the keyExpressions: @0, @1 from the keys in expansionMap
    let expandedSignatureMap: { [key: string]: string } = {};
    signatures.forEach(signature => {
      const pubkeyHex = signature.pubkey.toString('hex');
      const keyExpression = Object.keys(expansionMap).find(
        k => expansionMap[k]?.pubkey.toString('hex') === pubkeyHex
      );
      expandedSignatureMap['<sig(' + keyExpression + ')>'] =
        '<' + signature.signature.toString('hex') + '>';
    });
    const expandedKnownsMap = { ...preimageMap, ...expandedSignatureMap };
    const knowns = Object.keys(expandedKnownsMap);

    const { nonMalleableSats } = satisfier(expandedMiniscript, { knowns });

    if (!Array.isArray(nonMalleableSats) || !nonMalleableSats[0])
      throw new Error(`Error: unresolvable miniscript ${miniscript}`);

    let sat;
    if (!constraints) {
      sat = nonMalleableSats[0];
    } else {
      sat = nonMalleableSats.find(
        nonMalleableSat =>
          nonMalleableSat.nSequence === constraints.nSequence &&
          nonMalleableSat.nLockTime === constraints.nLockTime
      );
      if (sat === undefined) {
        throw new Error(
          `Error: unresolvable miniscript ${miniscript}. Could not find solutions for nSequence=${constraints.nSequence}, nLockTime=${constraints.nLockTime}. Signatures depend on sequence and locktime and would not match. Did you sign with all the keys declared and include all preimages?`
        );
      }
    }

    //substitute signatures and preimages:
    let expandedAsm = sat.asm;
    //replace in expandedAsm all the <sig(@0)> and <sha256_preimage(6c...33)>
    //to <304...01> and <107...5f> ...
    for (const search in expandedKnownsMap) {
      const replace = expandedKnownsMap[search];
      if (!replace || replace === '<>')
        throw new Error(`Error: invalid expandedKnownsMap`);
      expandedAsm = expandedAsm.replaceAll(search, replace);
    }
    const scriptSatisfaction = bscript.fromASM(
      substituteAsm({ expandedAsm, expansionMap })
    );

    return {
      scriptSatisfaction,
      nLockTime: sat.nLockTime,
      nSequence: sat.nSequence
    };
  }

  class Descriptor implements DescriptorInterface {
    #payment: Payment;
    #preimages: Preimage[] = [];
    #miniscript: string | undefined;
    #witnessScript: Buffer | undefined;
    #isSegwit?: boolean;
    #expandedExpression?: string;
    #expandedMiniscript?: string;
    #expansionMap?: ExpansionMap;
    #network: Network;
    #nLockTime: number | undefined;
    #nSequence: number | undefined;
    /**
     * Parses a `descriptor`.
     *
     * Replaces the wildcard character * in range descriptors with `index`.
     *
     * Validates descriptor syntax and checksum.
     *
     * @param {Object} params
     * @param {number} params.index - The descriptor's index in the case of a range descriptor (must be an interger >=0).
     * @param {string} params.descriptor - The descriptor.
     * @param {boolean} [params.checksumRequired=false] - A flag indicating whether the descriptor is required to include a checksum.
     * @param {object} [params.network=networks.bitcoin] One of bitcoinjs-lib [`networks`](https://github.com/bitcoinjs/bitcoinjs-lib/blob/master/src/networks.js) (or another one following the same interface).
     *
     * @see {@link https://github.com/bitcoinjs/bitcoinjs-lib/blob/master/src/payments/index.d.ts}
     * @throws {Error} - when descriptor is invalid
     */
    constructor({
      expression,
      index,
      checksumRequired = false,
      allowMiniscriptInP2SH = false,
      network = networks.bitcoin,
      preimages = [],
      signersKeyExpressions
    }: {
      expression: string;
      index: number;
      checksumRequired?: boolean;
      allowMiniscriptInP2SH?: boolean;
      network?: Network;
      preimages?: Preimage[];
      signersKeyExpressions?: string[];
    }) {
      this.#network = network;
      this.#preimages = preimages;
      if (typeof expression !== 'string')
        throw new Error(`Error: invalid descriptor type`);

      //Verify and remove checksum (if exists) and
      //particularize range descriptor for index (if desc is range descriptor)
      const isolatedExpression = isolate({
        expression,
        index,
        checksumRequired
      });

      const matchedAddress = isolatedExpression.match(RE.reAddrAnchored)?.[1];
      const keyExpression = isolatedExpression.match(RE.reKeyExp)?.[0];

      //addr(ADDR)
      if (matchedAddress) {
        let output;
        let payment;
        try {
          output = address.toOutputScript(matchedAddress, network);
        } catch (e) {
          throw new Error(`Error: invalid address ${matchedAddress}`);
        }
        try {
          payment = payments.p2pkh({ output, network });
        } catch (e) {}
        try {
          payment = payments.p2sh({ output, network });
        } catch (e) {}
        try {
          payment = payments.p2wpkh({ output, network });
        } catch (e) {}
        try {
          payment = payments.p2wsh({ output, network });
        } catch (e) {}
        try {
          payment = payments.p2tr({ output, network });
        } catch (e) {}
        if (!payment) {
          throw new Error(`Error: invalid address ${matchedAddress}`);
        }
        this.#payment = payment;
      }
      //pk(KEY)
      else if (isolatedExpression.match(RE.rePkAnchored)) {
        if (isolatedExpression !== `pk(${keyExpression})`)
          throw new Error(`Error: invalid expression ${expression}`);
        if (!keyExpression)
          throw new Error(`Error: keyExpression could not me extracted`);
        this.#isSegwit = false;
        this.#expandedExpression = 'pk(@0)';
        this.#expansionMap = {
          '@0': parseKeyExpression({
            keyExpression,
            network,
            isSegwit: this.#isSegwit
          })
        };
        const pubkey = this.#expansionMap['@0']!.pubkey;
        //Note there exists no address for p2pk, but we can still use the script
        this.#payment = p2pk({ pubkey, network });
      }
      //pkh(KEY) - legacy
      else if (isolatedExpression.match(RE.rePkhAnchored)) {
        if (isolatedExpression !== `pkh(${keyExpression})`)
          throw new Error(`Error: invalid expression ${expression}`);
        if (!keyExpression)
          throw new Error(`Error: keyExpression could not me extracted`);
        this.#isSegwit = false;
        this.#expandedExpression = 'pkh(@0)';
        this.#expansionMap = {
          '@0': parseKeyExpression({
            keyExpression,
            network,
            isSegwit: this.#isSegwit
          })
        };
        const pubkey = this.#expansionMap['@0']!.pubkey;
        this.#payment = p2pkh({ pubkey, network });
      }
      //sh(wpkh(KEY)) - nested segwit
      else if (isolatedExpression.match(RE.reShWpkhAnchored)) {
        if (isolatedExpression !== `sh(wpkh(${keyExpression}))`)
          throw new Error(`Error: invalid expression ${expression}`);
        if (!keyExpression)
          throw new Error(`Error: keyExpression could not me extracted`);
        this.#isSegwit = true;
        this.#expandedExpression = 'sh(wpkh(@0))';
        this.#expansionMap = {
          '@0': parseKeyExpression({
            keyExpression,
            network,
            isSegwit: this.#isSegwit
          })
        };
        const pubkey = this.#expansionMap['@0']!.pubkey;
        this.#payment = p2sh({ redeem: p2wpkh({ pubkey, network }), network });
      }
      //wpkh(KEY) - native segwit
      else if (isolatedExpression.match(RE.reWpkhAnchored)) {
        if (isolatedExpression !== `wpkh(${keyExpression})`)
          throw new Error(`Error: invalid expression ${expression}`);
        if (!keyExpression)
          throw new Error(`Error: keyExpression could not me extracted`);
        this.#isSegwit = true;
        this.#expandedExpression = 'wpkh(@0)';
        this.#expansionMap = {
          '@0': parseKeyExpression({
            keyExpression,
            network,
            isSegwit: this.#isSegwit
          })
        };
        const pubkey = this.#expansionMap['@0']!.pubkey;
        this.#payment = p2wpkh({ pubkey, network });
      }
      //sh(wsh(miniscript))
      else if (isolatedExpression.match(RE.reShWshMiniscriptAnchored)) {
        const miniscript = isolatedExpression.match(
          RE.reShWshMiniscriptAnchored
        )?.[1]; //[1]-> whatever is found sh(wsh(->HERE<-))
        if (!miniscript)
          throw new Error(
            `Error: could not get miniscript in ${isolatedExpression}`
          );
        this.#miniscript = miniscript;
        this.#isSegwit = true;
        ({
          expandedMiniscript: this.#expandedMiniscript,
          expansionMap: this.#expansionMap
        } = expandMiniscript({
          miniscript,
          isSegwit: this.#isSegwit,
          network
        }));
        this.#expandedExpression = `sh(wsh(${this.#expandedMiniscript}))`;

        const script = miniscript2Script({
          miniscript,
          network
        });
        this.#witnessScript = script;
        if (script.byteLength > MAX_STANDARD_P2WSH_SCRIPT_SIZE) {
          throw new Error(
            `Error: script is too large, ${script.byteLength} bytes is larger than ${MAX_STANDARD_P2WSH_SCRIPT_SIZE} bytes`
          );
        }
        const nonPushOnlyOps = countNonPushOnlyOPs(script);
        if (nonPushOnlyOps > MAX_OPS_PER_SCRIPT) {
          throw new Error(
            `Error: too many non-push ops, ${nonPushOnlyOps} non-push ops is larger than ${MAX_OPS_PER_SCRIPT}`
          );
        }
        this.#payment = p2sh({
          redeem: p2wsh({ redeem: { output: script, network }, network }),
          network
        });
      }
      //sh(miniscript)
      else if (isolatedExpression.match(RE.reShMiniscriptAnchored)) {
        const miniscript = isolatedExpression.match(
          RE.reShMiniscriptAnchored
        )?.[1]; //[1]-> whatever is found sh(->HERE<-)
        if (!miniscript)
          throw new Error(
            `Error: could not get miniscript in ${isolatedExpression}`
          );
        if (
          allowMiniscriptInP2SH === false &&
          //These top-level expressions within sh are allowed within sh.
          //They can be parsed with miniscript2Script, but first we must make sure
          //that other expressions are not accepted (unless forced with allowMiniscriptInP2SH).
          miniscript.search(
            /^(pk\(|pkh\(|wpkh\(|combo\(|multi\(|sortedmulti\(|multi_a\(|sortedmulti_a\()/
          ) !== 0
        ) {
          throw new Error(
            `Error: Miniscript expressions can only be used in wsh`
          );
        }
        this.#miniscript = miniscript;
        this.#isSegwit = false;
        ({
          expandedMiniscript: this.#expandedMiniscript,
          expansionMap: this.#expansionMap
        } = expandMiniscript({
          miniscript,
          isSegwit: this.#isSegwit,
          network
        }));
        this.#expandedExpression = `sh(${this.#expandedMiniscript})`;

        const script = miniscript2Script({
          miniscript,
          isSegwit: false,
          network
        });
        if (script.byteLength > MAX_SCRIPT_ELEMENT_SIZE) {
          throw new Error(
            `Error: P2SH script is too large, ${script.byteLength} bytes is larger than ${MAX_SCRIPT_ELEMENT_SIZE} bytes`
          );
        }
        const nonPushOnlyOps = countNonPushOnlyOPs(script);
        if (nonPushOnlyOps > MAX_OPS_PER_SCRIPT) {
          throw new Error(
            `Error: too many non-push ops, ${nonPushOnlyOps} non-push ops is larger than ${MAX_OPS_PER_SCRIPT}`
          );
        }
        this.#payment = p2sh({ redeem: { output: script, network }, network });
      }
      //wsh(miniscript)
      else if (isolatedExpression.match(RE.reWshMiniscriptAnchored)) {
        const miniscript = isolatedExpression.match(
          RE.reWshMiniscriptAnchored
        )?.[1]; //[1]-> whatever is found wsh(->HERE<-)
        if (!miniscript)
          throw new Error(
            `Error: could not get miniscript in ${isolatedExpression}`
          );
        this.#miniscript = miniscript;
        this.#isSegwit = true;
        ({
          expandedMiniscript: this.#expandedMiniscript,
          expansionMap: this.#expansionMap
        } = expandMiniscript({
          miniscript,
          isSegwit: this.#isSegwit,
          network
        }));
        this.#expandedExpression = `wsh(${this.#expandedMiniscript})`;

        const script = miniscript2Script({
          miniscript,
          network
        });
        this.#witnessScript = script;
        if (script.byteLength > MAX_STANDARD_P2WSH_SCRIPT_SIZE) {
          throw new Error(
            `Error: script is too large, ${script.byteLength} bytes is larger than ${MAX_STANDARD_P2WSH_SCRIPT_SIZE} bytes`
          );
        }
        const nonPushOnlyOps = countNonPushOnlyOPs(script);
        if (nonPushOnlyOps > MAX_OPS_PER_SCRIPT) {
          throw new Error(
            `Error: too many non-push ops, ${nonPushOnlyOps} non-push ops is larger than ${MAX_OPS_PER_SCRIPT}`
          );
        }
        this.#payment = p2wsh({ redeem: { output: script, network }, network });
      } else {
        throw new Error(`Error: Could not parse descriptor ${expression}`);
      }

      //TODO: There's a problem here. If I only want to use the Descriptor
      //class to compute scriptPubKeys this below should not be executed.
      //But then I would not have the nLockTime and nSequence
      //The tests fail because of this
      //NOOOO!!!! -> Same as I create fakeSignatures I should create fakePreimages!!!
      //Because in this case i am assuming that i know the priemages. is that a valid
      //assumption? I don't think so....
      //But I still should be able to create the addresses
      //Maybe I should flag it as INSANE, NOT_SOLVABLE, ...
      //
      //THIS SOLUTION A
      //THIS SOLUTION A
      //THIS SOLUTION A
      //THIS SOLUTION A
      //THIS SOLUTION A
      //THIS SOLUTION A
      //THIS SOLUTION A
      //THIS SOLUTION A
      //THIS SOLUTION A
      //THIS SOLUTION A
      //call it getConstraints().{nLockTime, nSequence}
      //Solution a. Do not store #nLockTime and #nSequence and only use getLockTime
      //and getSequence. getLockTime and getSequence are always computed using
      //fakeSignatures. Store #signersKeyExpressions
      //
      //Solution b. Do the same as with signersKeyExpressions. add a
      //knownPreimages. But do not add them yet.
      //Create a method. solvePreimages to solve them.
      if (this.#miniscript) {
        if (this.#isSegwit === undefined)
          throw new Error(
            `Error: could not determine whether miniscript ${
              this.#miniscript
            } is segwit`
          );
        const isSegwit = this.#isSegwit;
        if (!signersKeyExpressions) {
          //signersKeyExpressions can be left unset if all possible signers will
          //sign, although this is not recommended.
          const { expansionMap } = expandMiniscript({
            miniscript: this.#miniscript,
            isSegwit,
            network
          });
          signersKeyExpressions = Object.values(expansionMap).map(
            keyExpression => keyExpression.pubkey.toString('hex')
          );
        }
        //We create some fakeSignatures since we don't have them yet.
        //We only want to retrieve the nLockTime and nSequence of the satisfaction
        const fakeSignatures = signersKeyExpressions.map(keyExpression => ({
          pubkey: parseKeyExpression({ keyExpression, network, isSegwit })
            .pubkey,
          signature: Buffer.alloc(64, 0)
        }));
        const { nLockTime, nSequence } = satisfyMiniscript({
          miniscript: this.#miniscript,
          isSegwit: this.#isSegwit,
          signatures: fakeSignatures,
          preimages,
          network
        });
        this.#nLockTime = nLockTime;
        this.#nSequence = nSequence;
      }
    }
    getPayment() {
      return this.#payment;
    }
    getAddress() {
      if (!this.#payment.address)
        throw new Error(`Error: could extract an address from the payment`);
      return this.#payment.address;
    }
    getScriptPubKey() {
      if (!this.#payment.output)
        throw new Error(`Error: could extract output.script from the payment`);
      return this.#payment.output;
    }
    getScriptSatisfaction(signatures: PartialSig[]): Buffer {
      if (!this.#miniscript)
        throw new Error(
          `Error: this descriptor does not have a miniscript expression`
        );
      if (this.#isSegwit === undefined)
        throw new Error(
          `Error: could not determine whether miniscript ${
            this.#miniscript
          } is segwit`
        );
      //Note that we pass the original nLockTime and nSequence that were
      //used to compute the signatures as constraings.
      //satisfyMiniscript will make sure
      //that the solution given, still meets the nLockTime and nSequence
      //conditions
      const satisfaction = satisfyMiniscript({
        miniscript: this.#miniscript,
        isSegwit: this.#isSegwit,
        signatures,
        preimages: this.#preimages,
        constraints: {
          nLockTime: this.#nLockTime,
          nSequence: this.#nSequence
        },
        network: this.#network
      }).scriptSatisfaction;

      if (!satisfaction)
        throw new Error(`Error: could not produce a valid satisfaction`);
      return satisfaction;
    }
    getSequence() {
      return this.#nSequence;
    }
    getLockTime() {
      return this.#nLockTime;
    }
    getWitnessScript() {
      return this.#witnessScript;
    }
    getRedeemcript() {
      return this.#payment.redeem?.output;
    }
    isSegwit() {
      return this.#isSegwit;
    }
    //TODO throw if the txHex+vout don't correspond to the descriptor described
    //also check the redeemScript / witnessScript (if exists)?
    //f.ex. compute the scriptPubKey and assert it's the same.
    updatePsbt(txHex: string, vout: number, psbt: Psbt) {
      const tx = Transaction.fromHex(txHex);
      const out = tx?.outs?.[vout];
      if (!out)
        throw new Error(`Error: tx ${txHex} does not have vout ${vout}`);
      if (this.#nLockTime !== undefined) {
        if (psbt.locktime !== 0 && psbt.locktime !== undefined)
          throw new Error(`Error: transaction locktime has already been set: ${psbt.locktime}`);
        psbt.setLocktime(this.#nLockTime);
      }
      let inputSequence;
      if (this.#nSequence !== undefined) {
        inputSequence = this.#nSequence;
      } else if (this.#nLockTime !== undefined) {
        // for CTV nSequence MUST be <= 0xfffffffe otherwise OP_CHECKLOCKTIMEVERIFY will fail.
        inputSequence = 0xfffffffe;
      }

      const input: PsbtInputExtended = {
        hash: tx.getHash(),
        index: vout,
        nonWitnessUtxo: tx.toBuffer()
      };
      if (this.#expansionMap) {
        const bip32Derivation = Object.values(this.#expansionMap)
          .filter(
            keyExpression =>
              keyExpression.pubkey &&
              keyExpression.masterFingerprint &&
              keyExpression.path
          )
          .map(
            (keyExpression: KeyExpression): Bip32Derivation => ({
              masterFingerprint: keyExpression.masterFingerprint!,
              pubkey: keyExpression.pubkey,
              path: keyExpression.path!
            })
          );
        if (bip32Derivation.length) input.bip32Derivation = bip32Derivation;
      }
      if (this.isSegwit())
        input.witnessUtxo = {
          script: this.getScriptPubKey(),
          value: out.value
        };
      if (this.#witnessScript !== undefined)
        input.witnessScript = this.#witnessScript;
      if (inputSequence !== undefined) input.sequence = inputSequence;

      psbt.addInput(input);
      return psbt.data.inputs.length - 1;
    }
    finalizePsbtInput(index: number, psbt: Psbt) {
      const signatures = psbt.data.inputs[index]?.partialSig;
      if (!signatures)
        throw new Error(`Error: cannot finalize without signatures`);
      const scriptSatisfaction = this.getScriptSatisfaction(signatures);
      if (!scriptSatisfaction) {
        //Use standard finalizers
        psbt.finalizeInput(index);
      } else {
        psbt.finalizeInput(
          index,
          finalScriptsFuncFactory(scriptSatisfaction, this.#network)
        );
      }
    }
    expand(): {
      expandedExpression: string | undefined;
      miniscript: string | undefined;
      expandedMiniscript: string | undefined;
      expansionMap: ExpansionMap | undefined;
    } {
      return {
        expandedExpression: this.#expandedExpression,
        miniscript: this.#miniscript,
        expandedMiniscript: this.#expandedMiniscript,
        expansionMap: this.#expansionMap
      };
    }
    /**
     * Computes the checksum of a descriptor.
     *
     * @Function
     * @param {string} descriptor - The descriptor.
     * @returns {string} - The checksum.
     */
    static checksum(expression: string): string {
      return DescriptorChecksum(expression);
    }
  }

  return { Descriptor, parseKeyExpression, ECPair, BIP32 };
}
