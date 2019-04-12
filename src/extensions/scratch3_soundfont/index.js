const ArgumentType = require('../../extension-support/argument-type');
const BlockType = require('../../extension-support/block-type');
const Cast = require('../../util/cast');
const log = require('../../util/log');
const formatMessage = require('format-message');
const Soundfont = require('soundfont-player');

/**
 * Icon svg to be displayed in the blocks category menu, encoded as a data URI.
 * @type {string}
 */
// eslint-disable-next-line max-len
const menuIconURI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACgAAAApCAYAAABHomvIAAABgWlDQ1BzUkdCIElFQzYxOTY2LTIuMQAAKJF1kc8rRFEUxz8zyMRoFAsLi0lYGQ1KbCxmYigsZp4y2My8+aXmx+u9mTTZKtspSmz8WvAXsFXWShEp2dhYExum57wZNZI5t3vu537vOad7zwW7klYzRqMXMtm8Hgz43IvhJXfzM404cGLDFVENbS40pVDXPu4kTuzGY9WqH/evtcbihgo2h/CEqul54Wnh2bW8ZvG2cKeaisSET4UHdLmg8K2lR6v8YnGyyl8W60rQD/Z2YXfyF0d/sZrSM8Lycnoz6YL6cx/rJc54diEka4/MbgyCBPDhZoZJ/IwyxLj4UTwMMyg76uR7K/nz5CRXFa9RRGeVJCnyDIhakOpxWROix2WkKVr9/9tXIzEyXK3u9EHTk2m+9UHzFpRLpvl5aJrlI2h4hItsLT93AGPvopdqWu8+uDbg7LKmRXfgfBO6HrSIHqlIDTLtiQS8nkBbGDquoWW52rOfc47vQVmXr7qC3T3ol3jXyjflRWerNOZQZAAAAAlwSFlzAAAWJQAAFiUBSVIk8AAAAetJREFUWIXtmL9LHEEUgL/xxEIQLKaQ2FoIBkH8QQKx0XTaiU2C/4FBBwQbK4WkCDJ9Kq3Uzn/AHARFsbESkYhiYcAwKUKqEHEsdpVzuZudu9m9iOwHx8G+t28+3s4svIWCgnyR2ra44q3NEoEHmZfAK+B1/L8BLNe6J1dBqa2MJe6FhoGORFpzOii1bQX6edydntC6DQvG3XlTITMEtIcKJQnp4BIwl5VILZzP/ylQCIbSLMEfwBbwARgAVn1vzOM9aIETYPf+Z5S4qEyQ2r7zLZaV4HdgOxbaM0r8yqhuZoJrRomPGdV6RHFIQikEQykEQykEQ2n2TNIBlKijMbkLSm3bgHlgBugDRD335z00vQB2gN5Ga+S2B+MRc5MAOaijg/GQNEE0IJWIhiQXg8CoR+k/rqCXoNR2FlgBOn3yY0Y8845cwVRBqe0C8NlzsUp+euTsA2VXgnMPSm27gU8eC91WufYN9+MrA9NGCesqnHZIxvHbBufJC0aJa6IZ5G8i9A9YBN4aJa7SCqctnvyOUo3fwNdqAaPEutT2AJgEuoBjoGyUuPSo6yV4nBK/AeaMEqZWglHiFDj1FUqS+laX2u4AY1VCZ8B7o8Rho4v74POingK+EJ3KW6KurgIDecvVjdS29L8dCp4dd+O3aMI/GZDtAAAAAElFTkSuQmCC';

/**
 * Icon svg to be displayed at the left edge of each extension block, encoded as a data URI.
 * @type {string}
 */
// eslint-disable-next-line max-len
const blockIconURI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACgAAAApCAYAAABHomvIAAABgWlDQ1BzUkdCIElFQzYxOTY2LTIuMQAAKJF1kc8rRFEUxz8zyMRoFAsLi0lYGQ1KbCxmYigsZp4y2My8+aXmx+u9mTTZKtspSmz8WvAXsFXWShEp2dhYExum57wZNZI5t3vu537vOad7zwW7klYzRqMXMtm8Hgz43IvhJXfzM404cGLDFVENbS40pVDXPu4kTuzGY9WqH/evtcbihgo2h/CEqul54Wnh2bW8ZvG2cKeaisSET4UHdLmg8K2lR6v8YnGyyl8W60rQD/Z2YXfyF0d/sZrSM8Lycnoz6YL6cx/rJc54diEka4/MbgyCBPDhZoZJ/IwyxLj4UTwMMyg76uR7K/nz5CRXFa9RRGeVJCnyDIhakOpxWROix2WkKVr9/9tXIzEyXK3u9EHTk2m+9UHzFpRLpvl5aJrlI2h4hItsLT93AGPvopdqWu8+uDbg7LKmRXfgfBO6HrSIHqlIDTLtiQS8nkBbGDquoWW52rOfc47vQVmXr7qC3T3ol3jXyjflRWerNOZQZAAAAAlwSFlzAAAWJQAAFiUBSVIk8AAAAetJREFUWIXtmL9LHEEUgL/xxEIQLKaQ2FoIBkH8QQKx0XTaiU2C/4FBBwQbK4WkCDJ9Kq3Uzn/AHARFsbESkYhiYcAwKUKqEHEsdpVzuZudu9m9iOwHx8G+t28+3s4svIWCgnyR2ra44q3NEoEHmZfAK+B1/L8BLNe6J1dBqa2MJe6FhoGORFpzOii1bQX6edydntC6DQvG3XlTITMEtIcKJQnp4BIwl5VILZzP/ylQCIbSLMEfwBbwARgAVn1vzOM9aIETYPf+Z5S4qEyQ2r7zLZaV4HdgOxbaM0r8yqhuZoJrRomPGdV6RHFIQikEQykEQykEQ2n2TNIBlKijMbkLSm3bgHlgBugDRD335z00vQB2gN5Ga+S2B+MRc5MAOaijg/GQNEE0IJWIhiQXg8CoR+k/rqCXoNR2FlgBOn3yY0Y8845cwVRBqe0C8NlzsUp+euTsA2VXgnMPSm27gU8eC91WufYN9+MrA9NGCesqnHZIxvHbBufJC0aJa6IZ5G8i9A9YBN4aJa7SCqctnvyOUo3fwNdqAaPEutT2AJgEuoBjoGyUuPSo6yV4nBK/AeaMEqZWglHiFDj1FUqS+laX2u4AY1VCZ8B7o8Rho4v74POingK+EJ3KW6KurgIDecvVjdS29L8dCp4dd+O3aMI/GZDtAAAAAElFTkSuQmCC';


/**
 * Class for the translate block in Scratch 3.0.
 * @constructor
 */
class Scratch3SoundFontBlocks {
    constructor (runtime) {
        /**
         * The runtime instantiating this block package.
         * @type {Runtime}
         */
        this.runtime = runtime;

        /**
         * The number of drum and instrument sounds currently being played simultaneously.
         * @type {number}
         * @private
         */
        this._concurrencyCounter = 0;

        /**
         * An array of arrays of sound players. Each instrument has one or more audio players.
         * @type {Array[]}
         * @private
         */
        this._instrumentPlayerArrays = [];

        /**
         * An array of arrays of sound players. Each instrument mya have an audio player for each playable note.
         * @type {Array[]}
         * @private
         */
        this._instrumentPlayerNoteArrays = [];

        /**
         * An array of audio bufferSourceNodes. Each time you play an instrument or drum sound,
         * a bufferSourceNode is created. We keep references to them to make sure their onended
         * events can fire.
         * @type {Array}
         * @private
         */
        this._bufferSources = [];

        this._soundfonts = [];

        // this._loadAllSounds(this.runtime.audioEngine.audioContext);

        this._onTargetCreated = this._onTargetCreated.bind(this);
        this.runtime.on('targetWasCreated', this._onTargetCreated);
    }

    get INSTRUMENTS () {
        return [
            'accordion',
            'acoustic_bass',
            'acoustic_grand_piano',
            'acoustic_guitar_nylon',
            'acoustic_guitar_steel',
            'agogo',
            'alto_sax',
            'applause',
            'bagpipe',
            'banjo',
            'baritone_sax',
            'bassoon',
            'bird_tweet',
            'blown_bottle',
            'brass_section',
            'breath_noise',
            'bright_acoustic_piano',
            'celesta',
            'cello',
            'choir_aahs',
            'church_organ',
            'clarinet',
            'clavinet',
            'contrabass',
            'distortion_guitar',
            'drawbar_organ',
            'dulcimer',
            'electric_bass_finger',
            'electric_bass_pick',
            'electric_grand_piano',
            'electric_guitar_clean',
            'electric_guitar_jazz',
            'electric_guitar_muted',
            'electric_piano_1',
            'electric_piano_2',
            'english_horn',
            'fiddle',
            'flute',
            'french_horn',
            'fretless_bass',
            'fx_1_rain',
            'fx_2_soundtrack',
            'fx_3_crystal',
            'fx_4_atmosphere',
            'fx_5_brightness',
            'fx_6_goblins',
            'fx_7_echoes',
            'fx_8_scifi',
            'glockenspiel',
            'guitar_fret_noise',
            'guitar_harmonics',
            'gunshot',
            'harmonica',
            'harpsichord',
            'helicopter',
            'honkytonk_piano',
            'kalimba',
            'koto',
            'lead_1_square',
            'lead_2_sawtooth',
            'lead_3_calliope',
            'lead_4_chiff',
            'lead_5_charang',
            'lead_6_voice',
            'lead_7_fifths',
            'lead_8_bass__lead',
            'marimba',
            'melodic_tom',
            'music_box',
            'muted_trumpet',
            'oboe',
            'ocarina',
            'orchestra_hit',
            'orchestral_harp',
            'overdriven_guitar',
            'pad_1_new_age',
            'pad_2_warm',
            'pad_3_polysynth',
            'pad_4_choir',
            'pad_5_bowed',
            'pad_6_metallic',
            'pad_7_halo',
            'pad_8_sweep',
            'pan_flute',
            'percussive_organ',
            'percussion',
            'piccolo',
            'pizzicato_strings',
            'recorder',
            'reed_organ',
            'reverse_cymbal',
            'rock_organ',
            'seashore',
            'shakuhachi',
            'shamisen',
            'shanai',
            'sitar',
            'slap_bass_1',
            'slap_bass_2',
            'soprano_sax',
            'steel_drums',
            'string_ensemble_1',
            'string_ensemble_2',
            'synth_bass_1',
            'synth_bass_2',
            'synth_brass_1',
            'synth_brass_2',
            'synth_choir',
            'synth_drum',
            'synth_strings_1',
            'synth_strings_2',
            'taiko_drum',
            'tango_accordion',
            'telephone_ring',
            'tenor_sax',
            'timpani',
            'tinkle_bell',
            'tremolo_strings',
            'trombone',
            'trumpet',
            'tuba',
            'tubular_bells',
            'vibraphone',
            'viola',
            'violin',
            'voice_oohs',
            'whistle',
            'woodblock',
            'xylophone'
        ];
    }

    /**
     * When a music-playing Target is cloned, clone the music state.
     * @param {Target} newTarget - the newly created target.
     * @param {Target} [sourceTarget] - the target used as a source for the new clone, if any.
     * @listens Runtime#event:targetWasCreated
     * @private
     */
    _onTargetCreated (newTarget, sourceTarget) {
        // @TODO: Clone state.
    }

    /**
     * Decode the full set of drum and instrument sounds, and store the audio buffers in arrays.
     * @param {AudioContext} audioContext - audio context
     * @private
     */
    _loadAllSounds (audioContext) {
        const loadingPromises = [];
        this.INSTRUMENTS.forEach(instName => {
            loadingPromises.push(Soundfont.instrument(audioContext, instName, {soundfont: 'FluidR3_GM'}));
        });

        Promise.all(loadingPromises).then(players => {
            this._soundfonts = players;
            // @TODO: Update the extension status indicator.
        });
    }

    _loadSound (audioContext, instName) {
        if (this._soundfonts[instName]) return Promise.resolve(this._soundfonts[instName]);
        return new Promise(resolve => {
            Soundfont.instrument(audioContext, instName, {soundfont: 'FluidR3_GM'})
                .then(player => {
                    this._soundfonts[instName] = player;
                    resolve(player);
                });
        });
    }

    /**
     * Create data for a menu in scratch-blocks format, consisting of an array of objects with text and
     * value properties. The text is a translated string, and the value is one-indexed.
     * @param  {object[]} info - An array of info objects each having a name property.
     * @return {array} - An array of objects with text and value properties.
     * @private
     */
    _buildMenu (info) {
        return info.map((entry, index) => {
            const obj = {};
            obj.text = entry;
            obj.value = String(index + 1);
            return obj;
        });
    }

    /**
     * @returns {object} metadata for this extension and its blocks.
     */
    getInfo () {
        return {
            id: 'soundfont',
            name: formatMessage({
                id: 'soundfont.categoryName',
                default: 'Soundfont',
                description: 'Label for the Soundfont extension category'
            }),
            menuIconURI: menuIconURI,
            blockIconURI: blockIconURI,
            blocks: [
                {
                    opcode: 'playTest',
                    blockType: BlockType.COMMAND,
                    text: formatMessage({
                        id: 'soundfont.play',
                        default: 'play [INSTRUMENT] note [NOTE] for [DURATION]',
                        description: 'play note by the instrument'
                    }),
                    arguments: {
                        INSTRUMENT: {
                            type: ArgumentType.NUMBER,
                            menu: 'INSTRUMENT',
                            defaultValue: 1
                        },
                        NOTE: {
                            type: ArgumentType.NOTE,
                            defaultValue: 60
                        },
                        DURATION: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 1
                        }
                    }
                }],
            menus: {
                INSTRUMENT: this._buildMenu(this.INSTRUMENTS)
            }
        };
    }

    playTest (args, util) {
        const instNum = Cast.toNumber(args.INSTRUMENT);
        this._loadSound(util.runtime.audioEngine.audioContext, this.INSTRUMENTS[instNum])
            .then(player => {
                const note = Cast.toNumber(args.NOTE);
                const duration = Cast.toNumber(args.DURATION);
                player.start(note);
                player.stop(util.runtime.audioEngine.currentTime + duration);

            });
    }
}
module.exports = Scratch3SoundFontBlocks;
