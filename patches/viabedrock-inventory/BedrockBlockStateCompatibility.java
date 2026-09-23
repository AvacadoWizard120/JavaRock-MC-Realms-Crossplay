/*
 * This file is part of JavaRock's modified ViaBedrock compatibility classes.
 * ViaBedrock is GPL-3.0-or-later. The numeric compatibility aliases embedded
 * below were derived from CloudburstMC/Data's Apache-2.0 Bedrock palette at
 * commit 3255e82c0f89496abb2fb9747f32f1bc2926bea6 (Bedrock 1.26.50).
 */
package net.raphimc.viabedrock.protocol.storage;

import com.viaversion.viaversion.libs.fastutil.ints.Int2IntMap;
import com.viaversion.viaversion.libs.fastutil.ints.Int2IntOpenHashMap;
import com.viaversion.viaversion.libs.fastutil.ints.Int2ObjectMap;
import net.raphimc.viabedrock.ViaBedrock;
import net.raphimc.viabedrock.protocol.rewriter.BlockStateRewriter;

import java.lang.reflect.Field;
import java.nio.ByteBuffer;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Base64;
import java.util.Collections;
import java.util.HexFormat;
import java.util.Set;
import java.util.WeakHashMap;
import java.util.logging.Level;

/**
 * Adds Bedrock 1.26.50 state hashes to ViaBedrock's 1.26.45 lookup tables.
 * New stair corners and pane/fence connections retain their base orientation.
 * New colored stair/slab shapes degrade to their full material block, while
 * poplar blocks, straw beds, and new plants use behavior-compatible fallbacks.
 */
public final class BedrockBlockStateCompatibility {

    private static final int EXPECTED_ALIAS_COUNT = 5765;
    private static final String ALIAS_DATA_SHA256 = "630d18a535900fbfbe6a4ea2bc4aaa11f5313840e83d4364f4cf0c97dc07b8e5";
    private static final String ALIASES_BASE64 =
            "gA4MCA0oWLCAF/V0nZPp3IAmNqoxuOwWgCpNOskA846APh98YMSLOoBA+s73XuwsgEJilDtTLGqAUqSmeKK2HoBd9YdcYaCQgGXF" +
            "t9dAWj2AbaBWmAOKLICLXicBYDfJgI9+8xqLp3OAlYSCUmHjvoC+oSDuWbJCgMbC8TUSoJaA4dy0u2Crx4DjEqPBLI8JgOOlvFxh" +
            "oJCA4/L86BKovYDmfSlmaiCGgOelpVzkbFSA6CsZUkE1PIDpqX1ivPrTgPirYPX8UsGBAFJdwzpTA4FBYunHdh8hgV3ub26Dc12B" +
            "aUc6qLbj3YF5lnkIbAWfgX07/1JWFpqBjt/5ePgsVYGaMUCJz44pgZ+SuErtJS6BplTpov8FNIGtV0XE1pcQgbNqlndS4J6BtNHK" +
            "y53WjIHW5h7oEqi9gdyZl1xhoJCB5yDrHvLlaYHy79U/N9DAgfUpXtUWoneB+OwFcVyyP4IDliPnjrGaggYwmpgDiiyCEOsCbb4w" +
            "lIJJTpO5tv+tgkol8VxhoJCCTFl08Xnvh4JYk+KjQYqDglkMv5BuW4GCWq9/K2jMrIJrDGqfxzKsgmxbGrsERNeCovCBE6AP24Kq" +
            "KRB3Ze0WgsvGGImHy8+CzXY9jseD44LSXCQ9teThgtkzxYRzRK2C6ZTBbcN9ZYL7n/Ds1r0mgwPGgHcRzzuDGRxB4xeNNIMacGnN" +
            "VbxMgyBpB+2H4W+DR8V3bdzocINKVKzDOlMDg0q1M9ZaudGDZdij1ijfkoNro0ZeLOO5g4HfZ61oiqCDjcrYzn04d4OfdP8/490t" +
            "g6j8XwfkHt2Dw+3TrSmciYPJO6l3Ec87g+ctZBlX9XyD76xr1ZADWYP4xX1KUFA9hAf9jlxhoJCEDIDv/bYvwoQPzb7a6mJEhBeo" +
            "XZgDiiyENWYuBQo/0IREfZKE+v47hEyNc3eOSV+EVgQe8JqyrIRewzg+6D6yhGwmqT215OGEcMr4NRKgloSNGqrE1pcQhJCFMGLA" +
            "GH+Eka2sXORsVISSMyBOly01hJOxhGZnAtqEqYp3hKaXboSqWgcwfwLthKpaZMbkWwqEwRGVDbH/YYTF6rt0joeBhRNPQai2492F" +
            "GbkbYTcKE4UfTDr2rSLOhSOegAwWDaaFJ0QGUlYWmoU46AB4+CxVhUwoY1JEzrKFUFzwn1T9LYVXX0zBLI8JhV1ynXr86KWFdsA2" +
            "8YQq24WGoZ5cYaCQhZrbwwemayGFnzFl4BS6jIWhVA1C2kxEhbA4oZgDiiyFuvMJYsAYf4XA19/3XuwshcGNx7+HJc2F13VmqLbj" +
            "3YX0LfhcYaCQhgKb6a4/opiGAxTGlBhjiIYEt4YraMyshhUUcZ/HMqyGM3noMbjsFoYzist5VKFShlNp//CasqyGbmA/5oj15YZ3" +
            "fkSScYvqhoM7zIgdTLSGk5zIcW2FbIaxJzvQNHG1hrv9M+qvqjuGwyRI322FLYbKcQ7xMel2hvHNfmoy4GmHCLJK4fgslIcP4KrS" +
            "fteLhxroYrm2/62HHUIVhKaXbocf0+7CSKbwh0l9BkON5TSHhD1X88j14oeTay9KoRiEh5z/6BwXaO6HsZh3VMVk94eyBZVcYaCQ" +
            "h7aI9voMJ7uHudXFz+xKL4fBsGSYA4osh9tULse4Z0KH3241+gwnu4f2lXp7OFFmh/9zCbm2/62IDy/TrFKSoIgQuJxKoRiEiDci" +
            "sbnYfvuIVGIONCkK9Iht42OtaIqgiG/ywng4j4iIeG3i/UHEbIinQLvcuqvGiKvIF+nNs5GItYRN2RUlmIi9V0iotuPdiMXvZIA8" +
            "I8OIxgDoqjtR5ojRTA1SVhaaiO4xx3wQyO+I9jBqTprGq4kEHxeqO1HmiQd6pH6m8KyJMKmlXGGgkIk4ETl6OkpoiTz8Y24swkaJ" +
            "ROPKC1BzKIlFBW8VTQMxiUV6KkC2C5aJSTls3GqyhYlaQKiYA4osiVvevBqLp3OJZPsQZmoghomBgfuqhaTsiYIHxP1BxGyJigz7" +
            "hKaXbomaESmEKOSziateNC8YWiqJrKPwqpWakYmtHM2JGktzia6/jStozKyJuHbXQWeYFYm/HHifxzKsicp9+3cRzzuJ/XIG8Jqy" +
            "rIoIcArmJIwBihCjEhMcIa+KGGhG6jL97Ioey9mzUJ47iijd3/de7CyKPT+/NRKglopHYSBC2kxEilsvQtPeebyKZFWbcGV/topm" +
            "BTruWbJCinR5FfTb8X2Km9WFZojYYoqoAZ9AGMDcirnosd1876CKv7Av6M5KpYrzhQ04j80fiyRMpueOsZqLLGC/Zwr3WYsuRV7w" +
            "Hu3bizkwX5Ybk/GLQdu3qk4QcYtRXyTQtdKVi1ugflhvbP6LXA2cXGGgkItgkP0FCj/Qi2PdzNOWUjaLiXY8/bYvwouO53jVkANZ" +
            "i6CdgX7iWW2Lqtrz8vulhYut04+9Pe1ai7Fc8VxeAOGLuTfaqKiKmYvhKri9gocCi/5qFSkq8t+MBBCLWQLO24wIEU4CGRnIjBn6" +
            "yW06d3OMIV6LeKK2HowovziSB4vdjEGStOfzWLKMSvoZ1ZADWYxQ3okTHCGvjFFIwty6q8aMVdAe7Xe7mIxjcHuGFMHGjG4eAVZ5" +
            "2vWMcIMqx3YfIYx7VBRSVhaajJg5zn+60PaMoDhxWZjewIzasaxcYaCQjOS6fVNoI2eM6+bXRo9cVIzsI1MF1EiijO7r0QBSWxOM" +
            "7w12GPcLOIz+f+MCGRnIjRQ0HytozKyNK4oCptuc5Y1O+X+C55BgjVGYjyiHMh2NVT2L8q1GYY1XJNSMxFN6jVjHlCtozKyNp3oN" +
            "8JqyrI2ufDtAGMDcjcJwTd805deNxHUXXizjuY3EnYI1EqCWjd++tNJm/EuN5y4XgDwjw43z0iVWedr1jfmkS+yRs1WOACE7r29I" +
            "2Y4FN0nI4GGnjg6lhALEgfCOEA1B8gO6SY4S+XataIqgjh6BHPiF+YSONkALUG3yFY48Gsf4YvWdjkXdjGLe0FuOR9Svx3YfIY5J" +
            "5d/ulprbjlIJpkAYwNyOY/C42dLnmY6djRQ8OdUmjtBqbklGcpaO1MaDgDwjw47YTWX7HQXwjuG260zD6g6O4zhmmcWb+I7r476t" +
            "+Bh4juzYtRB/5ceO8QELQBjA3I7/uhaE+v47jwWohVwZdQWPCEHrvB2suY8KmQQBYDfJjwxXV0CBTl2PJb1+lqlQDo9KpYiCjGF0" +
            "j1K9aEC2C5aPVOL69qWtjI9X25a5k+VTj2M/4aT+gpKPZiMlxl/9VY96eoFtMdugj3t181R0i/aPhZPcQtpMRI+GJDe52H77j4qT" +
            "z8tI/VqPmAYfxAMLvY+jxeX3Xuwsj6hyHCzU+uaPrhiSXKzW4o+xhRMKvc0Bj7Wrt97J98KPxALQcOR/eo/tfSIe8uVpj/JNh1wZ" +
            "dQWP+1DJ3Lqrxo//2CXieaODkAx/r9OvgVKQDXiCgmq5v5AN+MTmJIwBkBZQpXL0TeyQQkHVg2TY/ZBCnr9QPO2KkEpAeFXu1rmQ" +
            "VVHvcGV/tpBj51mPpQSxkImGP+tTN6aQle7eQuVUTZCWK1oCKkCbkJjz2AP8YxqQmRV9DfjzI5Cbr5CAPCPDkL48JitozKyQ1ZIJ" +
            "ozGU3pEfzcJ3Ec87kT70txj3CziRPzRvqLbj3ZFRLPaC55BgkVGCFPCasqyRWIRCQBjA3JFdAINQbfIVkWdmYeyRs1WRbHhU4t7t" +
            "3pF8XGbL7eVQkYJE/BqLp3ORqsELYlPsLZGvP1DMimmukbXuqtgjTqaRuhVI9a3CUJHgSBJUF/ockenybgwjbXiR8+3m8kCi4pH8" +
            "Ea1AGMDckgcJo+Jz/8mSHPbt4FupR5I8AREtr8nbklka70BxiQ+Sc94ouwRE15KCVWz3cv3pkou+8kkZ4geSjUBtjseD45KV68Wi" +
            "+gBjkpsJEkAYwNySrrMDsJSWiZKvsIxfw30MkrpGvnxZYWaS1A1QIvWkrpLZCV5uLMJGkuo114uADpGS8hTnF+mMV5L+6wHrp5V3" +
            "kwHjncSR/WiTAqmJ2CNOppMNR+ihVHqLkxWa2omHy8+TJeO2qVNQRJMwLD69gocCkzSb1see9VOTP5WP/ABh5JNCDibHrRPEk1RM" +
            "RlGL0eWTVqe/6c2zkZNYIJlgVt7pk1+zvtsf77uTY/Lxt44ycJNmV7N3Ec87k5NYK/CasqyTnFWOX8N9DJOlWNDcuqvGk6ngLOYj" +
            "q4qTt4CJjWjR1JPU5MfDjUq5k9Vqq3wb6FWT4wlnAWA3yZPsSdyHDuEEk+ymxkyS5YOT+otxI1CMq5P/WfZwZX+2lAlCsz215OGU" +
            "CpRru2By1ZQLy+X3XuwslBB3KyM6oPGUFBrMAhkZyJQXz1fyybBdlB0ri48qFpiUM45G56kvn5Q/9uU/O0xGlEAzYQ0oWLCUQx2E" +
            "EaL7KpRJSh6GLpgYlGhELStozKyUf5oQn4eM15TYFru++thtlOj8vhVNAzGVAoxJQBjA3JUEEzSC55BglQcIilQX+hyVFMyHbizC" +
            "RpUvKPt4OI+IlTToHmGjjnKVRPC6EpY0nZVIGM/xMel2lVBiR81VvEyVVMkSZf30NJWEM8PNVbxMlYpQGUkZ4geVnfXt9eqq6ZWm" +
            "GbRAGMDclazn6wl+UKmVr49nQtpMRJWxEarmHgfQlclUsl4s47mVyytXWqHszZYDIvZEG5EWliDK1/CasqyWNcb5VBf6HJY3SHSS" +
            "cYvqlj/zzKakCGqWQjpf/NhPY5ZFERlAGMDcllPPX1/9DBiWaxuq06+BUpaTfxfVkANZlpQ93o8qFpiWlgXLUEvg1Zao8wjvUZ1+" +
            "lqvrpMDn9WGWuVeI5iSMAZbaNEXBLI8Jlt6j3dKdDWiW6Li+98EkMJbpnZb4VlndluwWLbyu+6+W79HveKK2Hpb7OFd4+CxVlwCv" +
            "xu13u5iXAiigZADm8JcJu8XmHgfQlx8QVFzttuKXKULdOvVCh5cy9WIDnbtLlz1gMvCasqyXRl2VVMVk95dfcJo+6D6yl2Acdcvt" +
            "5VCXYYiQib7JzZd/MecLUB8el4Gb453DGJmXjRFuBQo/0JeWrs1XkP2Yl5n2fVpoW3+XqCA/R8WZHZepYf1wZX+2l7Sccr8KetyX" +
            "wdde9nO4ZJfHM5KLgA6Rl92WTfKnR7SX6AHLahQojZfp/uw7kUQ/l+o7aAl+UKmYApODcgHzUZgSTDQraMysmCk1K7y5RtWYNeiX" +
            "MbjsFphcZQce8uVpmGkA28JAqDWYcm1blSKy8ZiIaSb9QcRsmJMExRGi+yqYqDU7y+3lUJislFBAGMDcmLEQkUkZ4geYt7glrWiK" +
            "oJjZMQJ0joeBmPIg1u2H4W+Y+mpOzVW8TJj+0Rla/9wfmQvpcGlW/HmZEN/Rt44ycJkc+/6Ez3KgmS47ys1VvEyZNFggTMPqDplH" +
            "/fT5lLLwmVbv8g0oWLCZWxmx2x/vu5lfZFl5VKFSmXJCsm8q/36ZdTNeXkv01JmtKv1HxZkdmcrS3vCasqyZ388AUG3yFZnsQmb8" +
            "2E9jme8ZIEAYwNyZ/ddmXFMEEZoBwYfDsrr6mgPH4VBL4NWaPkXlhCv+g5qEPEzE1pcQmoir5M7zBWGak6Wd9KxR1pqWHjTAWQO2" +
            "mqHmC2Ruk0GapUBeePgsVZqqt83ieaODmqyct+epL5+as8PM4nP/yZq7sfGq6xkTmtecgqlTUESa52g58JqyrJrwZZxYb2z+mwVb" +
            "mQIZGcibKTnuB6YXF5sro+qhbSCgmzcZdfoMJ7ubQLbUU+b1kZtMBXdlr6E7m1IoRktvoSSbU2oEcGV/tptXOed8WWFmm16kebQM" +
            "Yseba99l63WgT5txO5mH1gaKm4eeVO79P62bkgnSbb4wlJugVR08ALBvnAAFpz830MCcEwjixeqwPJwV4AGAPCPDnBx1YpjMuvic" +
            "HP7XlqlQDpwyPnQ7/lssnDWJK9Jm/EucPQzMDfjzI5xBw+GE+v47nFsYmEzD6g6cgzkJcOR/epyTtKEe8uVpnJwo3fiF+YScnidt" +
            "yPM9b5yh/G/QNHG1nKRyVc1VvEycqNkgXqnkJpy+nqZqLj3QnMkge/2+R5qc1Ipg3gVBlpzYQ9HNVbxMnQD3+QIqQJudBSG43sn3" +
            "wp0fO2VTTdy/nSEQ26o7UeadJudPgQmZip06riNy9E3snTsyx24swkadQvybNs1KCJ1XMwRLb6EknWYWf9y6q8addNrl8JqyrJ2R" +
            "S5WEppdunZZKbfzYT2Odp99tWKj8Cp2ryY7Dsrr6nbTUQtMOdtyduuhphi6YGJ3oTeyH1gaKnfL8OJIHi92d9Jwhzn04d54DW5m3" +
            "ZcoDnja/8+oZuFGePa2k8QJJz55L7hJoGJtInk9IZXj4LFWeVL/U5iOrip5WpL7rUzemnmpOQB7y5WmeatCX+FZZ3Z6EwhxKoRiE" +
            "npFwQPCasqyevt1UhPr+O57TQfUSpC8sntWr8ZZvCIue2BXmW2WCwJ7fKSuYA4osnuEhfP22L8Ke/DBNQHGJD5798f/sO7V9nv7m" +
            "f1l8nzWfCKyAt7Zqzp8V52zvH6hWnxtDoIQr/oOfH5OXZaH8jp8gnOygKx36nzwR2WLAGH+fRurchi6YGJ9ZTKfSVz83n1oyU+Yk" +
            "jAGfdWhaLxhaKp95YuvXQFo9n6F3T3Ttx22fqg2uPzfQwJ+8W+vDsrr6n70Q6brsmCefxn1pjc6i45/IPGrcuqvGn9+RMtJm/Euf" +
            "5NESjMmlLJ/nKLKWqVAOoAR/+AejlL6gLUEQbTp3c6A1cERvKv9+oEYw5PTb8X2gTAR20955vKBOelzNVbxMoFYNF6MWfHGgXgmy" +
            "R2/mZKBgugBWedr1oGWrwK1oiqCgcJcnDZXo2qBzKIL6FD+ToIJL2M1VvEygpIYNQU4t36CrAAAF1EiioMlDbFb35MagyxjiqjtR" +
            "5qDQ71aBCZmKoO0EojbNSgihBQL3cGV/tqELpfptMdugoRAehty6q8ahFDO3U+b1kaEe4uzwmrKsoSTmOOj7CVahLgkcdxHPO6FA" +
            "UnT82E9joUVbz/GmH7GhUed0VP70A6FU65650rGNoVUsF0C2C5ahVdGVw7K6+qFcXbuc+NVnoWpsFydVqI2hfJ4s0lrV+qGCUodl" +
            "ofyOoYN9sLcdoPyhsgoHPzTNwaHBee/njrGaoeDH+u3DwFih4tDAsdeH3qH19hldGoMzoflQbHj4LFWiAKzF7v0/raIU2J78AGHk" +
            "ohwIK4uADpGiI4gY917sLKJyur5XKFeTon1J/A76JyWif7P4mhkQkqKJMTKYA4osoqY4VEQbkRaiqO6GXSanPKLJm55h9/SHosuh" +
            "I5e+K4Gi0pfbPzfQwKLddEOdk+ncouYZ4GZqIIai9suz/JaLG6MDVK7WAUc+oxZdc81VvEyjHe9ygDwjw6MjavLa6mJEo0eQBeyR" +
            "s1WjSfp/P8g2WaNLf1Z4l890o1QVtT830MCjZmPyw7K6+qNnGPC+lqAuo3CFcJF4quqjiUYDw7K6+qOJmTnSZvxLo52eCRyNJPOj" +
            "sgeL8aYfsaPOfBZWedr1o9mm5Md2HyGj9gx9yOBhp6QAFR6mwIR4pAlGp6akCGqkGp8uDZXo2qQc5gM/jDVGpB0wiQUSV6ikK/Zm" +
            "phnL6KQsF++DZNj9pFFm4ugSqL2kUdJ/HB0K9aRg+Een3YMFpHUg6ao7UeakdvxXXkv01KR5G8NwZX+2pHr3XYEJmYqkfb+7AsSB" +
            "8KSPKmd3UuCepJcMqTbNSgiko7GbHVgnWaSu1DpML/3MpK8K/nBlf7akuiaN3LqrxqS8Q7tV7ta5pL47vleQ/ZikwAeDvCt3FaTZ" +
            "I+jnjrGapNsyvWlW/Hmk4n0Vt44ycKTvY9b1UCe4pPafKoAUJSKk+kqDfFlhZqT/2ZzDsrr6pQZlwqCi3W6lB3uj3CZhMqUR3IcG" +
            "xakGpRR0Hir/sJSlIpvF6cMOh6UqitKSB4vdpSupp3j4LFWlLFqOYff0h6UuApC3jjJwpS8jfwmGQkGlWajG4J5zqKVcEg5C3tXI" +
            "pWI6otR77NSldj1z322FLaWK0AHixahDpZDt95/HMqyln/4gYMSLOqWqtMzyp0e0pb7gpfECSc+lxhAyjyoWmKXN5t9bHXB5pejO" +
            "YIA8I8OmCmAV/UHEbKYzOTmYA4ospjWlBb+jrV+mS5jNdxHPO6ZS9o1SKI8npm8+z/dy/emmc6OlbPYMnKZ3lYbL7eVQpnyf4j83" +
            "0MCmgNRjdnlbMqaGnLZ2G07Ipod8Sp2T6dymoNO6/JaLG6atXLXZq09Fprbog9J+14umwGV6zVW8TKbEbB6Rzx9Kpspvl3limxGm" +
            "zXL5z+xKL6bnpceBCZmKpvCyU9Jm/Eum9AKGQ3I+YKb1h11tmbdfpv4dvD830MCnDgJLQtpMRKcQa/nDsrr6pzOhQNJm/EunS3ts" +
            "/NhPY6dXppvwmrKsp1wPkvVQJ7inoBSEzIpprqeqHSWbwmxjp7K3u/Xqqumns06uovoAY6e22W9SVhaap8SnNQ2V6Nqnxu4KO+It" +
            "P6fHOJABaE+hp9GO55umqTWn1b6XXizjuafWH/aHDuEEp/NCpSN99j+oBbaQn5wVBqgfKPCqO1HmqCEEXlqh7M2oIyPKcGV/tqgk" +
            "/2SBCZmKqDkybnOo2JeoQRSwNs1KCKhNuaIhAi9gqFj1i3ojYzmoWRMFcGV/tqharNegot1uqGN/75CW8o6oZC6U3LqrxqhlyFOB" +
            "CZmKqGZLwlmY3sCoaEPFTJLlg6hqD4q/1X8cqJlr3epSD6OosG3JpEzldaixEoBp/AyOqLGDqth8WSuotfHNhPr+O6i75I4DG6D/" +
            "qL58JSABmH+o0MnLnZPp3KjVsa54+CxVqNZilWz2DJyo2SuGDTBKSKkGGhU34L2zqSBFeuMXjTSpNNgI5m+wSqk69f6fxzKsqT2c" +
            "qwXUSKKpP9Z9E6AP26lBlRD8losbqWjorPSsUdapawFgaqWJ1qlwGDmEK/6DqXBw7HlUoVKpd+7mXsd4gKnBgX98G+hVqd1BQJgD" +
            "iiyp3gZe5O1ymqn8/pRV0pcuqhlG1vsdBfCqGbUONvwrEaodq6xpTASVqiUQ/lxOHS6qJqfpPzfQwKoq3Gpyz1MrqjGEUZ2T6dyq" +
            "StvB/JaLG6pXZLzdVVdMqmDwitYo35Kqam2BzVW8TKp0d559DKMYqnd7ANOWUjaqe8RhQtpMRKqPCMfwmrKsqpNywxmuH1Kqmrpa" +
            "0mb8S6qeCo04dCZLqp7d52oRCuGqn49kcUO/Zqqj/ZM0oBSOqq+G6StozKyqunQAw7K6+qrB1CMNsf9hqsaJ6bnSsY2qzHbr3CZh" +
            "Mqr8qbrskbNVqwGuovCasqyrBheZ6lIPo6sLYd9ZAs7bqw+t51coV5OrJTtC0LXSlatRrbFeLOO5q1QlLJ9sdGqrXIzuvqTaEKtc" +
            "v8L5lLLwq11Wta34GHirYOF2UlYWmqtqvsEvGFoqq26vPA2V6NqrcPYRRuBFVKtzCddC5VRNq3sGP3limxGre5bun1CxPKt8F1bO" +
            "fTh3q4An/XwQyO+rlCX4LxhaKqufBy/BLI8Jq7Cb6n25D7yrulVbzvMFYau7eal3Ec87q8WoUzSgFI6rywxlVvfkxqvNK9FwZX+2" +
            "q934/0wv/cyr3vmnn8cyrKvjOnV+pvCsq+PxhVBL4NWr98GpFgQXS6wA5x+E+v47rAL9kn3Na0CsAxsMcGV/tqwEtN6c+NVnrA2H" +
            "9pCW8o6sD9BagQmZiqwQU8lOmsarrBJLzFA87YqsE6Yy8YQq26wUF5G012cHrCb/hiflYLCsMDuP+M3/laxDc+Tt/BeqrFKMXLnS" +
            "sY2sVdCeGVf1fKxWfNQ2/CsRrFp10Kf27XysW4ux43pxQKxg+V9UdIv2rGXslQ4ZuRSsaIQsI6ughqxuaIjYI06mrHrR0p2T6dys" +
            "f7m1ePgsVayAapxpTASVrIMzjQIyMjOsoDMmAsSB8KyqGVu4ASGtrLAiHDuKxbqstt45MbjsFqzKTYHYGXUfrNKvH+38F6qs5P4F" +
            "n8cyrKznpLICKkCbrQBYVnlqAHCtAgzb7Na9Jq0aIECH1gaKrSFAK8pVXCStIfbtU8lga600C2XwEfEjrT9ajrqbvJGtRKP4iYfL" +
            "z61+B5v9TgTZrYKrU99thS2tm1lEUmHjvq29+dzDBVFCrcNO3fAe7dutw7T2fBvoVa3LfA9tar0XrdCv8D830MCt1ORxfc1rQK3b" +
            "jFidk+ncrd8lygY8LQyt9OPI/JaLG64K+JHZ0ueZrhR1iM1VvEyuFUv/vLlG1a4ef6VyDosDrh/O+3mbs1GuMVfvePgsVa45EM7w" +
            "mrKsrj16yhYEF0uuRMJh0mb8S65HeH//XNtKrkgSlDweLlKuSOXubbsS6K5OBZo0oBSOrk/4N5y2eSKua9wqDbH/Ya52fvLYfFkr" +
            "rnnwdG0x26CufRS/uwRE166CF00THCGvrpzIqMd2HyGuqJJvqjtR5q6rtqnwmrKsrqvgBG8q/36urAM/7gExO66wH6Dt/BeqrrVp" +
            "5lys1uKuwQjr8IDFLa7RZnUvGFoqrtX32XL0Teyu7oSjNvwrEa78aS/hHUzFrwERftOvgVKvBsfJ7paa268HXryqThBxrwrpfVJW" +
            "FpqvF8IBePgsVa8a/hhDNj1Nrx0R3kaPXFSvJQ5GfQyjGK8lnvWUUpknryXq704Ev42vKRBXNKAUjq8qMAR/utD2rz6kxw2Mq0Ov" +
            "SQ82xNaXEK9kXWLSnQ1or2+wWjSgFI6vdRRsU03cv693M9hwZX+2r3wiVLqbvJGviQGun8cyrK+NQnx6/Oilr6HJsBmuH1KvrQWZ" +
            "cs9TK6+uvOWn9u18r7Dr2jG47BavtgF739BpOa+3j/2QlvKOr7nYYYEJmYqvulvQUkTOsq++H5i4gW8Or9pDlvx4B5yv2nc/UlYW" +
            "mq/anjJeLOO5sAWTuN/QaTmwCwFmVHSL9rAP9JwKb7ENsCIC9BOgD9uwJNnZnZPp3LAmy4MewU3nsCnBvHj4LFWwKmPO917sLLAt" +
            "O5QF3Do6sFQhYrgBIa2wdFWI28N9JrB3A5A8KHe3sHy3JupSD6OwjwYMn8cyrLCRrLkNKFiwsKwU4ukstR+wr+KCrWiKoLDLSDLG" +
            "q1QdsMv+9FdzaHKxINJj917sLLEjKOMB/SbjsSyzWuMXjTSxVZ37/JaLG7FXC57ZFSWYsW1W5PPI9eKxdYQWcRTFHrF2mzR8G+hV" +
            "sX7seHojYzmxkrMJ6PvaW7GXAYdEG5EWsZh8a2nfW2+xmTa+gDwjw7Ghn23xhCrbsbUAmN1876CxyIesdbiTCrHJ1wJ9RbtYsdhe" +
            "65gDiiyx2U5cExwhr7HgVtyRzx9KseMY1fCasqyx54LRIQIvYLHuymjSZvxLsfGAhvuy00Ox8u31Yrz607H4DaE0oBSOsfoAPpkM" +
            "cRuyFCojupu8kbIV5DENsf9hshd/dry5RtWyIIb543pxQLIrytPqr6o7si9Is3pn2EWyP4ojGwUdpbJNIAYCxIHwslKadqo7Ueay" +
            "Vb6w8JqyrLJWC0bxqzlCsl9x7WBW3umyZN1bkJbyjrJqHadpQH9OsmsQ8vQqzTSyjSPXWG9s/rKqpvfxph+xsrDP0PJAouKytPGE" +
            "UlYWmrK3h0PSfteLsr50BzD91RWyxxnlO5FEP7LPFk1yDosDss+m/Jf8oS6yz/L2Ua7HlLLTGF40oBSOsubBQ61oiqCy6KzOETaz" +
            "SrLyS37mJIwBsvMXPbnYfvuzDmVpx571U7MZGQPNVbxMsxm4YTSgFI6zMwm1n8cyrLNEmnPDsrr6s1cNoHZ5WzKzV8mZ8HTgCbNY" +
            "xOykTOV1s2AJguN6cUCzYZgEkJbyjrNj4GiBCZmKs3LP/Lm2/62zhEud8Xnvh7OEf0ZSVhaas45Hh+gSqL2zmLg3jMRTerOZCzpQ" +
            "S+DVs7UJbVR0i/azxjFcQBjA3LPO4eCdk+ncs+7dIkqhGISz9eMD4a8drbP+KWm4ASGttCa/LfVQJ7i0O7TACX5QqbRPMU1FK3o3" +
            "tFBQBZapUA60Vhzp9CrNNLR1UDnDAUwWtI5Ny9C10pW0okyn1gFHPrSyvoNXKFeTtM0w6gWnLuq01rth2Bl1H7TeqbMvGFoqtQ/Q" +
            "oxKWNJ21H4wddL7NJbVBCY5AcYkPtUKEcmnfW2+1Y3Kbdr3QPrVz3wlyR6NDtYJm8pgDiiy1id6Et44ycLWNINzwmrKstZGK2B1Y" +
            "J1m1m4iNBrDrWLWc9fxmZwLataIVqDSgFI61pAhFpAqJMLWmUc+gYIEptb/sOA2x/2G1x27pGVf1fLXKZbS8uUbVtcqPAN/QaTm1" +
            "1dLa7lmyQrXWIblAtguWtdlQun4R4Ey125u/3NNqirXiytd8Be6VtemSKh6vJay1+kAVZZZLR7X8on2qO1HmtgATTfVVQUm2B/Ag" +
            "E6AP27YJefRkAObwtg7lYpCW8o62FCWuZZZ3R7YVGPnpLLUftjcr3lTFZPe2VK7+9VAnuLZhj0rWKN+Stmh8DjSn3Ry2btMXEpY0" +
            "nbZxIew/O0xGtnh9efzYT2O2eR5UdbiTCrZ5+v1GsK9/tn0gZTSgFI62krTVFOC7Ubac8kegYIEptp0fRL2ChwK2tQvbptuc5ba2" +
            "d+nHdh8htrhtcMtI/Vq2wyEKzVW8TLbDwGg0oBSOttD945CLz6a23RG8n8cyrLbuonrDsrr6tu/Yzg2V6Nq3B0OnQzY9TbcKEYnY" +
            "fFkrtxP9vxOgD9u3LlOk9SP3jrcuh01SVhaatzOBEpCW8o63OE+O6BKovbdCwD6JGktzt18RdFR0i/a3arMz8JqyrLdttgCC55Bg" +
            "t5/rCuVZJbS3qDFwuAEhrbeo+L9tMdugt7xBTc1VvEy30Mc08aYfsbgAJPDwgMUtuALtbJIHi924HWrXcGV/trgfWEC/V0QPuB91" +
            "hzmg1rO4KjEYSlBQPbgvqZbXFCbYuDDqTGkT0iC4OCL8PCh3t7hIMq8DnbtLuExUrtJXPze4TZkLXORsVLhg/PPt069JuHc48QlR" +
            "NvG4e6apQBjA3Lh/+EmfxzKsuIDDaNvDfSa4hKvfPzfQwLig22qRzx9KuL9+gGvh/Fa4xpyPDbH/YbjJlCR4aNUsuNAvWkC2C5a4" +
            "0orkeKK2HrjphJcCGRnIuOsRlUtvoSS47Ix5ad9bb7kLRmfVkANZuQ16onMTyDe5HecQdfGrSrksbvmYA4osuTOXknlUoVK5NigX" +
            "SUZylrlFkJQDBuNRuU4QTKBggSm5UFnWpAqJMLlfYK/y+6WFuX/a4fIDukm5g1jBcxPIN7mFo8bZKWKDuZD6bexPPeu5k5oxE7EN" +
            "l7mmqoSqO1HmuaobVPj/SVC5uO1pkJbyjrm+LbVwlI9cub8hAOzWvSa5zyZYUxnhLrnRnFvixahDudMe606axqu54TPlX8N9DLnn" +
            "zXTxhCrbuflIhFwI21q5/rcF6lIPo7oLl1HZ0ueZuhKEFSmpxQe6JAMESlq3hronKGw0oBSOuje0tzUSoJa6PLzcGIrDWLpCWea6" +
            "/yp4ukb6TqQKiTC6XxPiqoWk7LpnQPXBUsqfum0pEc1VvEy6cH07Qt7VyLp7BeqM4cefupTyW8K0u9W6l6kBE6AP27qYqoHDsrr6" +
            "uqEZs8kz7J+6pjtqfFlhZrqxS65G4EVUurQZkNwmYTK6ti/7DbH/YbrIqenZFSWYus3tE4PPt0K6z+pLNs1KCLrYj1RSVhaautt4" +
            "FoLnkGC64leV6BKovbrsyEWUGGOIuxS7OvCasqy7OlaxUYvR5btJ8xHaWw2fu07BM+sTEkW7WJWzdxHPO7tbCzdp31tvu8ZzME0n" +
            "Ppa7x3LecGV/trvJfY49St66u87gg+Wc54G7z6l4MbjsFrvxNAE8KHe3u/Zctd1VV0y796ESXORsVLwIJ1twZX+2vCFA+Az7Pvi8" +
            "LrPmPzfQwLxUrFzZFSWYvGhEnazDS5+8asHjGounc7xwpJYNsf9hvIhO3wpvsQ28lRmcR8WZHbyWlIBp31tvvJlD3859OHe8t4Kp" +
            "fhHgTLzA7pnoEqi9vNZ3AJgDiiy85+jjAhkZyLz6Yd2ZDHEbvQlotvalrYy9D0BauZu50L0cM4NXkP2YvSni6PWtwlC9LWDIdr3Q" +
            "Pr0vq83kJ3qYvT2iOBdbFZ69YvVwkJbyjr1oNbxs6odVvWt4tvGEKtu9e6Ri5m+wSr19JvJSRM6yvYs77FwZdQW9qL8M7fwXqr21" +
            "n1jdfO+gvbyMHC1TzQ692rnAPqrwsL3hsO/3cv3pveG8vjUSoJa96uZEDZXo2r3xAlWZDHEbvfaxGZapUA69+lRPDy+Wab4AtXYz" +
            "5pXKvgkb6Z+HjNe+FzEYzVW8TL4ahUI/NM3Bvh69SgLEgfC+JQ3xl9/ftL4mxPv7HQXwvipzZgOdu0u+Pvpixl7D3L5CsojDsrr6" +
            "vkshuszd9Ka+W1O1O+ItP75gOAINsf9hvmEpl2zqh1W+alMb3Lqrxr539RqAJa87vnnyUjbNSgi+ewIXdL7NJb6MX5zoEqi9vpbQ" +
            "TJBuW4G+pt4Mz5YkOr6+w0HwmrKsvsDBU9stOYO+2QcD6zLtCb7z+xjeBRWmvvjJOu69Gky++053qKiKmb8FEz5p31tvvwzp9TG4" +
            "7Ba/EQCFB+em2b8nrhn3XuwsvykV33o537W/MvUBnZPp3L85V/F4orYev0bF9I5dDFq/TBN+Exwhr79T+rejFnxxv3F65XBlf7a/" +
            "c4WVQPTmwb98N81SYeO+v6BkvNmrT0W/oakZXORsVL+yL2JwZX+2v9i77T830MDAE9482AnNusAarJ0Nsf9hwDJW5g4ZuRTAPyh/" +
            "8BHxI8BJsPPWKN+SwGGKsHpn2EXAm4UVCoSJ18CkaeSctnkiwLNwveunlXfAxjuKU+b1kcDZs9TgfXKRwO5kMgIZGcjA9o8qGVf1" +
            "fMElrGnqGbhRwScu+VXu1rnBUw5luwRE18F20uBSYeO+wXuNi9yjXJjBi7j2+x0F8MGLxMU1EqCWwZDcW7ZMoGHBmwpcnLZ5IsGk" +
            "XFYS2Z5wwbJ5Y0qhGITBsyPwozGU3sG5D289teThwcSNSTuKxbrBzxX4lDXXrcHQzQL3cv3pwekCabtgq8fB6nnLdxHPO8H1KcHQ" +
            "h/ytwgVbvD+MNUbCCkAJDbH/YcILMZ5wlI9cwhRbIty6q8bCIf0hiyPHUMIj+lk2zUoIwiUKHnho1SzCL6XPbcN9ZcJSVpFeLOO5" +
            "wmjLSPCasqzCdH4jzn04d8KAzCBWedr1wqLRQeO/AjfCpVZ+rFKSoMKvG0Vp31tvws3grxlX9XzC6xaoPxKbQsL3bfc2zUoIwv4C" +
            "vqbAhHjDG4LscGV/tsMdjZxEnu7Iwysw3YT6/jvDRXaDfc7x/cNLsSBc5GxUw1w3aXBlf7bDb94/yo5jEcOCw/Q/N9DAw4PDDnlU" +
            "oVLDkSR/XGGgkMPEtKQNsf9hw9xe7QMboP/D6TCG8BHxI8PzuPrSfteLxAX/hTWT1hnEGa1fNRKglsQc8McNMEpIxEy18z6ACv3E" +
            "TOVMhAqFSsRaFEPcuqvGxF1zgfGEKtvEXXjE71GdfsRdiTeX/KEuxHBDkVA87YrEebzKkc8fSsSNRas4j80fxJKEwqlTUETEsPDL" +
            "NRKglsTPtHDtw8BYxNE3AFmY3sDE7uz4QLYLlsUaLTMxuOwWxSWVktj5VJHFNcD98B7t28U1zMw1EqCWxU5kXQfbhlvFbpVQN+C9" +
            "s8V61QnzyPXixY0ooG0x26DFkwpwvwqzzsWfMcjUMgS0xbQYn2lAf07FtEgQDbH/YcW1OaVllndHxbdSFomHy8/FvmMp3LqrxsXM" +
            "BSiHeb9Jxc4CYDbNSgjFzxIlbWq9F8XR24+fxzKsxdmt1nFthWzF6FRQXizjucXvZZUg3t/fxfFoE+5ZskLF/SryaVb8ecYBm625" +
            "tv+txgaHOQEvWjvGBs7eGounc8Yp7tQ2/CsRxjEMzkpQUD3GM2AbxqtUHcZM2UjnaQo+xk9ehaFUeovGWSNMad9bb8aDszNa/hw5" +
            "xoqA3vO77WjGoXX+Ns1KCMaoCsWbwmxjxsIHeQafGo3G1y9Pn8cyrMbnDGYSljSdxvGB5Mvt5VDG92vniYfLz8cGP3BwZX+2xxnm" +
            "Rs44axjHN8FQE6AP28c7LIZcYaCQx18hLTwod7fHhmb0BsWpBseHNMQjcE1Ix5M4jfAR8SPHnRo4gra9bsedwQHdfO+gx6yir0FV" +
            "cHjHrZhQ0LXSlcfDtWY1EqCWx8b4zgmGQkHH7kbP1Raid8f2vfpCKhMEyAQcSty6q8bIB5E+lFKZJ8gaS5hMkuWDyCwtdUC2C5bI" +
            "N02yPDnVJshCkgcai6dzyEqc258HVkrIVNHboxZ8ccha+NI1EqCWyGi7Dzwod7fIkhF/LxhaKsi6kztSRM6yyML0oZgDiizIzWaL" +
            "Zm9tV8jPnZnVT0yKyN/JBPPI9eLI7yNV5iSMAcj3Vl0THCGvyPhsZAuFjmLI+16jMXI0vcj9tGQSljSdySTdEPAe7dvJKNdHaUwE" +
            "lckuFGtC2kxEyU+UVLqbvJHJU+2O0LXSlcleIKZllndHyV9BrGlAf07JaGsw3Lqrxsl5GixxFMUeyXvjlp/HMqzJg7XdZm9tV8mb" +
            "cBrqr6o7yaDFzNceSALJpSYrtTyf1smyAC97OFFmyd1oIspVXCTJ+WaMpP6CksoK//HnjrGayhit2HL0TezKNV1buAEhrco4Em+R" +
            "zx9Kykt+BTbNSgjKUhLMn2x0asper2pXKFeTynWaw5apUA7KgTdWn8cyrMqbceo9teThyqsGSHxZYWbKwiaIhKaXbsrD7k3DOlMD" +
            "ys7O1lzkbFTK5TSNXGGgkMruxJkCGRnIywJp5pYD2UDLBlHjqKiKmcsPcoOSB4vdyxZOKIYumBjLKEX/JtoL/cs9QJTwEfEjy0fJ" +
            "CNnS55nLVzZ1x3YfIctrTK48KHe3y229bTUSoJbLcQDVBdw6Ost2Ck9UdIv2y5hO1tjAqn7LoMYBNyv678ukltO45qfdy64kUdy6" +
            "q8bLsZlFn1CxPMvOlLi7BETXy+FVuT/j3S3L9KTim11OQ8v+2eKmwIR4zAUA2TUSoJbMClFjgQmZiswtkXeZxZv4zEX9LzSgFI7M" +
            "ZJtCTprGq8x3bpJqGXVezHmloNGlRIPMpWaqNRw8xMy7obqC55BgzNLfTmz2DJzM11VSkgeL3czuoaek/oKSzPVYzwLEgfDM+azB" +
            "7E89680IKK1wlI9czSXrnZ/HMqzNLb3kahl1Xs0+xeNOmsarzUV4IfWtwlDNTy4ysZKXz81cCDZ3jklfzV9heNgjTqbNZgMMrQAr" +
            "4s2HcCm/V0QPzYiM9K1oiqDNtx25SUZyls3fZWK4ASGtzeZtYYT6/jvN61gfudh++831hgw2zUoIzgEZlncRzzvOBww2HvLlac4M" +
            "cMnVkANZzhulsTJMxqXOKz9dn8cyrM45cLNAtguWzj+Plg2x/2HOUnWPw7K6+s5WldrnjrGazmpJn1zkbFTObEcnQtpMRM5t9lTG" +
            "5FsKzn+rIrXxWQTOjzyUXGGgkM6WkjtT5vWRzpb8SkFVcHjOoiCkslkzIs6wWeqsUpKgztQwbR7y5WnO9KwP5iSMAc8DsZttw31l" +
            "zwZhU7alPyDPF8V0NRKgls8bCNwCMjIzzyASVlR0i/bPQlbd3Gqyhc9Kzgg61gL2z0u1G36PJ47PTp7avJCv5M9YLFjcuqvGz1uh" +
            "TJumqTXPcKBbBacu6s+CYttBVXB4z4RIf3Xxq0rPi13AQ43lNM+YcdfE1pcQz56s6aZbZljPqOHpm8JsY8+vCOA1EqCWz7RZaoEJ" +
            "mYrPxPF3oKLdbs/XmX6WG5Pxz97tW9nS55nP8AU2NKAUjtADqAsxcjS90AaBDXcRzzvQDqNJWZjewNAhamDskbNV0CF2mW3DfWXQ" +
            "LdNH7Yfhb9A34EGC55Bg0E9usSoeJK/QYw+xy+3lUNBo+Ecai6dz0G7zePAR8SPQfOdVYff0h9CIq/sBv6jq0JiprqFUeovQnKH1" +
            "2CNOptCyMLRs6odV0LJqNzJgXknQz/Okn8cyrNDQpblLCiDD0NJ9g1JWFprQ6M3qUkTOstDvgCjyA7pJ0PHSu2ZvbVfQ+TY5vJCv" +
            "5ND62zO4ASGt0QYQPYKMYXTRCCAIbBOgztEJPVB5VKFS0SzFtC8YWirRMXgwwwFMFtFOVexp31tv0VqRc7sERNfRZXYGpRwtWNFm" +
            "Yb/JM+yf0XDEO1zkbFTRdIq+PCh3t9GJbWm4ASGt0ZVgJr2ChwLRmOZzCVE28dGg+gl8WWFm0brAm2HcV/nRv7ypbizCRtHFrbg1" +
            "9s6s0dVHZJ/HMqzR4FMKUYvR5dHnPnM+gAr90fxOJUqhGITSDJcBqVNQRNIUUaZc5GxU0i0Nn2oRCuHSOv+RUYvR5dJAmkJXkP2Y" +
            "0kiej9jAqn7SWmHxoVR6i9J4yqvDsrr60pPCRDsmwtLSotArWXyfNdKtuaJxbYVs0rBpWrL7NxnSyhpdVHSL9tLsXuTgFLqM0vW9" +
            "InrlH4fS+KbhsZKXz9L6zhcCGRnI0xqoYgH9JuPTLlCGckejQ9Mv/WmGLpgY00J53sEsjwnTSLTworFeUdNS6fCfbHRq015hcYEJ" +
            "mYrTbvl+nPjVZ9OBoYWScYvq04OvF3FthWzTiPVi3XzvoNOaDT00oBSO062wEjUcPMTTuKtQVe7WudPLfqBxbYVs09fbTvEx6XbT" +
            "4D4AfBvoVdPqxn+C55Bg0+xZNCqQdCLT9gEkRiHKKtP5drgtyCy20/86ui0ogYTUG5tpoIpBvdQm71xlofyO1CukBdOvgVLULwJq" +
            "Ix92fNQytAL+FaDj1EKxtaxSkqDUUH/j6BKovdRccj42CmZQ1HyFilJWFprUfSvLNRw8xNSNRd+fxzKs1JLV8VXu1rnUm9rCahl1" +
            "XtSgwBypU1BE1KM+QLjmp93UpOM6uAEhrdSwB/1eLOO51LAYRH7iWW3UvP8YNs1KCNTgZktwZX+21PX2P3+60PbVEGnGzN30ptUa" +
            "zEJc5GxU1TN1cLgBIa3VM4g7MXI0vdU/aC3BLI8J1ULuegz7PvjVUc71EpY0ndWIDbfmI6uK1ZFGekIqEwTVoArT5iSMAdWsn3d+" +
            "EeBM1a1Cz8K0u9XVsdp7EtmecNW+Wa1c5GxU1c9sCTan13vV0P1QUYvR5dXRNLm4ASGt1dcVpm27EujV6qJJTJLlg9XvzUINsf9h" +
            "1fKmltUWonfV+CW3mAOKLNYDA/9jz0u11gRp+KT+gpLWBcOfm9RqLdYZqK0DnbtL1iLSssOyuvrWJNtzorFeUdZGI+V9zvH91kzY" +
            "Ml0mpzzWV8GpZm9tV9ZacWGvUS8S1lwAiAcPcsbWdCJkVHSL9taJk6vGq1Qd1ozSZOeOsZrWn8UpheM3nNairui1PJ/W1qQA4nii" +
            "th7Ww1D6bTHboNbEsGkM+z741thYjX1Fu1jW2mLr73NaPdbsgeW9gocC1vNJzwUKP9DXCGl4gQmZitcZAYWn9u181yslF28/G0XX" +
            "K6mMjseD49cttx5tw31l1zCn82oUKI3XMv1p0n7Xi9dEFUQ0oBSO104AFnwb6FXXV7gZKh4kr9dgmyNiU+wt128ccTwod7fXd10e" +
            "QxG7ltd+KsZAT1qQ14HjVfTb8X3XiAjSA527S9fMy1fnqS+f19y8CQkTuPjX4cqnl/yhLtfl28RRi9Hl1+y5vKioipnX8py7aVb8" +
            "edgDr0nDtiXr2AZ6RSsMTjvYIe+oudKxjdgmjZFSVhaa2Ccz0jFyNL3YKorTbcN9Zdg0CIC8uUbV2DdN5p/HMqzYOYpukgeL3dg8" +
            "3fhZmN7A2EXiyW3DfWXYTutBuAEhrdhY9f1vKv9+2FtAX1JWFprYX7LkGVf1fNhjnI7sTz3r2HChnvJTytjYim5ScGV/ttiQxNKr" +
            "k7kk2J/+RnwQyO/YunHN0If8rdi9y+BQS+DV2MTUSVzkbFTYxS8bVHSL9tjLJzhML/3M2N2QQjUcPMTY5QNU3DvIWtjpcDTE1pcQ" +
            "2Oz2gQH9JuPZMhW+4nmjg9k7ToE3K/rv2Vanfnpn2EXZV0rWxl7D3Nlb4oIPL5Zp2WhhtFzkbFTZejeXyo5jEdmBHa1ivPrT2ZSq" +
            "UFA87YrZnK6d4BS6jNmiLb6YA4os2apBwEqhGITZrQwGZ3lTvNm+T82pU1BE2czaucOyuvrZzuN6pltmWNnoj07VkANZ2erA3HcR" +
            "zzvZ8TWnXSanPNn24DlSKI8n2gHJsGoZdV7aBHloq6cnC9ozm7LKVVwk2jYeN/AR8SPaPcGwhPr+O9pJzTCCOS+V2mN6SFcoV5Pa" +
            "Zl3POI/NH9puuHAJUTbx2nVHgncRzzvagmCUeZuzUdqEavLzHWJE2paJ7LnYfvvamW/AH6Qo5tqdUdYBYDfJ2sMJjKRM5XXaygqG" +
            "byr/ftrSeTtqGXVe2tUtHnLpI0za178lahl1Xtrar/ptvjCU2t0FcNYo35La/62yAhkZyNsBwCAtyCy22wqjKmX99DTbDMC4Pug+" +
            "stsX58xJRnKW2xjxv3rlDnfbK+tc+IX5hNtI1od4+CxV21GiM5gDiizbdtNe61M3ptt6je8DG6D/24bEEAVpsPHbi9KulFKZJ9uh" +
            "ypa8uUbV26VR8akU8RvbsIJMLrZWQtu7Pasc6/Th271jsF4s47nb0JWYUlYWmtvRO9ktyCy229SS2nFthWzb4VXtn8cyrNvlmVfv" +
            "X+t52+/q0HFthWzb+PNIuAEhrdwrW5aJh8vP3C6vWz830MDcNHZZcGV/ttxKBk2HDuEE3FMxI0ef+BLcZHnU1DIEtNxsYpbb/zD4" +
            "3G7cUFzkbFTcbzciVHSL9tx/t/dKWreG3IeYSSoeJK/clv6IBacu6tybh40R9Son3MhYjGlW/Hnc2a+DkgeL3dzcHcXtd7uY3OHr" +
            "11R0i/bc5VaIOtYC9tzyovNC5VRN3P75EtIdRyjdAK+Fdr3QPt0BUt27YKvH3QXqiQuFjmLdJD+ezjhrGN0rJbRmZwLa3Ua2pNxq" +
            "soXdS07aNvwrEd1MNcWYA4os3VEBix7y5WndVxQNXHs7p91a+V9KWreG3Wo1xm8q/37da3VniYfLz91t+2zwEfEj3XbiwMOyuvrd" +
            "eOuBm11OQ92U9cKw4TaU3Zs9rll8nzXdoOhAVdKXLt2lkJ+E+v473bjn86MxlN7dvskxmkw2C93APNR3Ec873dnAnOxPPevd3aO5" +
            "v1dED93gJj7wEfEj3gdQN98R0UXeD8Fz05ZSNt4QZdY8OdUm3iM2U9dAWj3eLZ4nhi6YGN4ucvnoH0ov3jIMt+MXjTTeNrHHw7K6" +
            "+t5HWd39ti/C3lwbpS8YWirefIFCZm9tV95/NSVn6ws33oHHLGZvbVfehLgBYsAYf96LGyv1UCe43pGqL8zd9KbetKsxWv/cH97L" +
            "hF3LsFh33s3b/dWQA1ne6zNDRopICd7y3o54+CxV3vuUyjwod7fe+6o6mAOKLN8cI49vKv9+3yDbZe79P63fJJX2BsWpBt812rWf" +
            "ULE83za4Yh7y5WnfRLz9hlaZr99HbUtWedr130xfC+xPPevfe0PgKh4kr99+muFmb21X34td9J/HMqzfj6Fe8wnzgN+vt+ySB4vd" +
            "37MUC4m+yc3f2LdiPzfQwN/efmBwZX+23+1QQJQaKK7f8llFbTHboN/0DlSDZNj93/05KkP18AvgCecwExwhr+ALmYMn4byh4BMo" +
            "IK1oiqDgFLxndxHPO+AVECZpVvx54Bk/KVR0i/bgKb/+RrCvf+AxoFAtyCy24Dm8Vm0x26DgO57pudKxjeBDJBzDsrr64GNRdxFB" +
            "iUXgajD79gRUR+Bw9Fq6m7yR4IYlzOnNs5Hgi/PeVHSL9uCcqvpGj1xU4Kq3jHMTyDfgq1rkvwqzzuCv8pAH24Zb4MmEC/C+Oyng" +
            "zEteXDZrEODOR6XDOlMD4OLHDoA8I8Pg5mrvgMk8puDpCKrHdh8h4PY9zJgDiizhARwUYCVDruEFAWZGsK9/4Qo7Y/de7CzhIvOI" +
            "nwdWSuEjOKdGsK9/4TYwCISml27hRUW1VdKXLuFZbglXKFeT4WLv+p+HjNfhh6vAwwFMFuGKLkXwEfEj4bnJes/sSi/hum3dP+Pd" +
            "LeHNPlra6mJE4dh7AOvJUjbh2+TTvJCv5OHcFL7fbYUt4eC5zsOyuvrh8WHk+gwnu+IEor1BVXB44gaoHqQMhYDiD4goGbXVtuIm" +
            "iUlxbYVs4ik9LGuVEz7iLsAIZmoghuI1IzLxph+x4juyNskz7J/iRhE2nZPp3OJeszheqeQm4mH1IVzkbFTiblgWw/oKyOKF7HrA" +
            "EEN84pzmlXj4LFXiniSzNRKgluKlskGYA4os4rNSc5CW8o7itS9hVnna9eK3V6u/Cnrc4sBaL8d2HyHiyuNs8qdHtOLOnf0Kb7EN" +
            "4t/ivJumqTXi/Vb7AFJbE+MMBJv1VUFJ4w6VnznIRtzjEqmx5QB/M+Mi1KgZV/V84yii6GoZdV7jOall6Avba+M+XmzD3cvS41xx" +
            "JPyWixvjXRwSjWjR1OOCv2k/N9DA45WHhUwv/czjp0ExTvQIIOO/1zPnjrGa48NHMFR0i/bj08gFUa7HlOPdUnW++tht4+4xIDUS" +
            "oJbkET4dkgeL3eQR3ajHdh8h5BS127eOMnDkFTXMSlBQPeQ1++VUdIv25EBcER+FJvPkRrMBO5FEP+RI7e0TYqAf5GwAKjm37ETk" +
            "cmtwU/uEXuR4T6zG5FsK5JBy9n0fNJ/krwltUa7HlOTNQK5KWreG5M+Bq0FVcHjk0ylsVHSL9uTvTbxSKI8n5QTl82nfW2/lDPgB" +
            "qoWk7OUYWtNp31tv5RptPwH9JuPlIQ+gbyr/fuU0NkzwEfEj5Tppf8XqsDzlXkjRy+3lUOVj0YHa6mJE5WR15EON5TTlbVABtQIC" +
            "E+Vt7nR9dTqK5XdGYc/sSi/lhezauOan3eWGHMXbw30m5YrB1cOyuvrlqx9p0LXSleXB/QZpVvx55dCRUG3DfWXl3ys57fwXquXl" +
            "uj3UMgS05f8zAKlTUETmDYE07JGzVeZG7px4+CxV5kgsujUSoJbmSELDPzfQwOZPukiYA4os5l2dSreOMnDmYV+yu2By1eZ4pgQO" +
            "GbkU5ouZlDgq1TzmkwpIzn04d+aYRFdT5vWR5qdfAgP8Yxrmtgyi+P9JUOa4naY2Hj7V5ryYWP1BxGzmwsfPQBjA3ObjsWzrteNy" +
            "5vrzrncHHSjnByQZgmq5v+cKDs+UUpkn5xlwEzSgFI7nJ6pOUS99fucsx3A/N9DA5zymnzUSoJbnRdY3yRDIzudObx5KoRiE51FJ" +
            "OEtKABnnfdAMTgS/jeeXxcuo4r/Z59juj/5F2+nn4APsVHSL9ufwuwg/O0xG6AerpD215OHoE5oYSlBQPegkD6jZFSWY6DLlwzbN" +
            "SgjoOnr9iB1MtOhGHStB4TNZ6FG0q6mMPSHoVyQ3eVShUuhZEXROBL+N6HdItU4Ev43oru36ad9bb+i1lDuCOS+V6LcACKbbnOXo" +
            "wmLaad9bb+jEdUYFpy7q6MS5qSPUJeXo5HGGwkCoNekAaFk2/CsR6Q3ZiNdAWj3pIU5o05ZSNukuKbp8G+hV6S7PW+69GkzpL/Th" +
            "tTyf1ukwJMzYGXUf6TTJ3MOyuvrpOCP+5iSMAelWA8i5tv+t6VhI+3Blf7bpbPUWqVNQROmJM0DqUg+j6Ynce/Casqzpj8JE0If8" +
            "remrgAPvX+t56ciB+3pn2EXpzHI3+479J+njXQXskbNV6fI0wTUSoJbp8krKPzfQwOn0eIJKoRiE6f4waBMiqTTqA8dukgeL3eoL" +
            "Z7m3tmrO6gvujZHPH0rqFmZhnZPp3OoYkbOQ/hQd6jBnoJapUA7qQkxeV5D9mOpDQDn9i41b6lFnCQemayHqYBSp7gExO+pipa0y" +
            "dDbO6mLKoc59OHfqZYCr7gExO+psz9ZAGMDc6nrZQy8YWirqlWQ4TC/9zOqXTzW8n8MH6qvuKzSgFI7qsSwghhTBxuq0FtaX/KEu" +
            "6tAexlJh477q5q6mNRKglurrmZs6jSNL6u/ePsVmwMfq+bZQy+3lUOr6WX3xhCrb6w2y0WbME/vrJOzchKaXbusr8Qs/N9DA6zN1" +
            "qhKWNJ3rOT+nudKxjes8g+kZV/V86z0wHzb8KxHrR43OUdQzCOtKoTpML/3M61Ub09gjTqbrgvaWAe/j8OuG5nECxIHw66YMsFGL" +
            "0eXr3O2PkJbyjuvc7co2zUoI6+SDBIRzRK3r5wuhuFCzu+vwJTJFiztg7Anl7+tTN6bsIVC8Ua7HlOwk668yYF5J7CYN2bqbvJHs" +
            "K1dDSqEYhOw69o4mciiA7D7Vym4swkbsRpPj8BHxI+xI67tgVt7p7Fj2AWnfW2/sX5xCheM3nOxsauFp31tv7G59TQlRNvHsdlW4" +
            "ejpKaOx/X78Nsf9h7IIMj1Jh477sjnmNvpagLuyX7zfDsrr67KStJwHsBI3sqmhBfBvoVezF2RVFIuBX7NjXYusTEkXs2fzosZKX" +
            "z+0CUQJwZX+27RaqmxE2s0rtMO7lClPJm+0z5ILwmrKs7VWICvMJ84DtWqOfn2x0au1go79tMdug7Wr5EJCW8o7tcooCfhHgTO12" +
            "ej7/OQUu7YDOU8OyuvrtgfQ6vLlG1e2De/PHdh8h7ZKTT28q/37tnDzINRKglu2cUtE/N9DA7bVvwLQMYsftwpm6lKgcJO3EYWMN" +
            "leja7efEyRKWNJ3t7FRlTJLlg+32igND9fAL7ftvEAtQcyjuBR8znZPp3O4KHLDxqzlC7gyttC7KLsfuD4iy8as5Qu4W191AGMDc" +
            "7kNPyNmWFKbuRO4/PzfQwO5V9jI0oBSO7lo1I3Blf7buXh7dm6apNe5i1Z+6m7yR7pC2rTUSoJbulaGiPjcrUu6XnyUxuOwW7pnm" +
            "RdBk2NzuqeK0UEvg1e7BUX1eLOO57sz2x9Jm/Evu1fkSPzfQwO73gbuqO1Hm7wi2PxOgD9vvDCg+ubb/re8RFxn3Xuws7yz+nfbx" +
            "y9vvMPMcc06EMu9IoFdbHXB571222/1BxGzvhvWWkJbyju+G9dE2zUoI75aVzexPPevvmN1uSUZylu+aLTk6jSNL75yCiw2V6Nrv" +
            "s+3256kvn+/O87Y2CmZQ78+kX3Oo2Jfv772H67Xjcu/wm+rwEfEj7/LzwmQA5vDwAv4Iad9bb/AJpEl65R+H8BZy6GnfW2/wGIVU" +
            "DPs++PA4gZS67Jgn8D2+6dkVJZjwQfc+w7K6+vBdTn98G+hV8GEeO8yKaa7wdP1fdI6HgfB3OUy+qNvK8H/qCUFVcHjwgt9p52kK" +
            "PvCIhRv1I/eO8JtuTrHXWKDwrFkJcGV/tvDAAacTHCGv8MCyog2Mq0Pwxwon0LXSlfDOyWLg0JHk8N3sifCasqzw4dA+1JQSuPD+" +
            "MsG8uUbV8P+QEegL22vxBAewUmHjvvEEq6abwmxj8RySCXMTyDfxKtZaw7K6+vEz01ECxIHw8TSTLtC10pXxRlrYPzfQwPFGcZ+o" +
            "tuPd8UfKfhHfwjjxWGaS0h1HKPFsocGJqgQP8W5pag2V6NrxdpbHmAOKLPGWXGxQPO2K8aCSCkef+BLxryc6nZPp3PGwYZP+Rdvp" +
            "8bKmF5gDiizxuZC59VVBSfHA3+RAGMDc8dYVU1b35Mbx2P7J5iSMAfHchfTxhCrb8eVxaoSml27x6Cq3QsIot/Hu9kY/N9DA8fn6" +
            "K9j5VJHx/jbToGCBKfH//jk0oBSO8gQ9KnBlf7byCCbkn1CxPPIiAA+qO1Hm8i3/CtWQA1nyOr60NRKglvI/qalB4TNZ8kNyyDSg" +
            "FI7yQ+5MzLrQ1fJZg0e5tv+t8mAp06FtIKDydv7O0mb8S/J/voVQS+DV8oABGT830MDyoYnCqjtR5vLVkG2Jh8vP8tcGpPqb0+Ly" +
            "8qheXsd4gPMcMAZBVXB48zD9nZCW8o7zMP3YNs1KCPM58Lydk+nc80Q1QD43K1LzRoqSDZXo2vNd9f3yp0e082MKK/yWixvzePu9" +
            "KwxOO/N5rGZ3UuCe84jZLwFgN8nzmcWO6Avba/Oao/HwEfEj85z7yVkCztvzprU3dbiTCvOzrFB+jyeO89pdZ52T6dzz6/9Fw7K6" +
            "+vQLJkLI4GGn9B8FZng4j4j0J+lMQVVwePQs53DjvwI39DKNIvF574f0OpEKniN4ZPREbf8utlZC9EzsO6i24930VmEQcGV/tvRX" +
            "lQt4+CxV9Gq6qRiKw1j0cJHPt44ycPRzKq+LgA6R9H24c1qh7M30h/SQ8JqyrPSpmBjrteNy9K6zrabAhHj0sRj/vLlG1fSzdceU" +
            "Ndet9MaaEHa90D701N5hw7K6+vTqhpJ3Ec879O6jaxOgD9v08HmmqLbj3fUWqciNVAwW9RhxcQ2V6Nr1GJsHkG5bgfUgns6YA4os" +
            "9UqaEUtKABn1UWyoXWa3/vVU2T9tw31l9VkvQZ2T6dz1WmmaAe/j8PVcrh6YA4os9WOYwPj/SVD1gB1aU03cv/WJ7EoRe6+89ZIy" +
            "vkZsML71mP5NPzfQwPWkAjLco1yY9ag+2qQKiTD1qgZANKAUjvWuRTFwZX+29cwIFqo7Ueb1zQCDBacu6vXpsbBFiztg9gIWpw2x" +
            "/2H2CjHancMYmfYadc5KUFA99iEG1dJm/Ev2KgkgPzfQwPY1sL4DmJrA9kuRyao7Ueb2VGlLgueQYPZ8v0JvKv9+9pywZVPJYGv2" +
            "tm+EUmHjvva54Y88Hi5S9tjzeOk239z22wWkkJbyjvbhjE5AGMDc9umgt5IHi9328JKZDZXo2vcH/gTu/T+t9w0SMvyWixv3DwBs" +
            "0mb8S/cQ5GNKUFA99xZc4RX62iP3F52Xp/qFa/cc+wNAGMDc9x7A2jb8KxH3HtZH/UHEbPcjA8QutlZC9yO0bXr86KX3KWncfFlh" +
            "Zvcy4TYFCj/Q90PNlfMJ84D3RKv48BHxI/dHA9BcrNbi91C9PnIOiwP3hGVunZPp3PeHjrXQtdKV95YHTMOyuvr3pjHLqsivofe1" +
            "LknT3nm897bipUC2C5b3uT4veKK2HvfCcyDxhCrb98kNbW06d3P33JUp/HgHnPfudgYrDE479/b0Qqi24934AZ0SePgsVfgUwrAU" +
            "4LtR+BpK3XlUoVL4HG+/uAEhrfgdMraPKhaY+CfAel5L9NT4O/O6e298pPhYu7SjFnxx+F19zpff37T4dJJTCjcdQ/h8s4U2zUoI" +
            "+H7maMOyuvr4hsJMMbjsFviaga2otuPd+Kl0+16p5Cb4swnzwSyPCfi12aOSAJR5+MJ5eA2V6Nr4wqMOlBhjiPjKptWYA4os+M6A" +
            "v/GEKtv418ZPVMVk9/jbmMKfxzKs+N/7z5rvjqX49CF67E896/j0ohhO9Agg+P7hRnFthWz5AzdInZPp3PkEcaH28cvb+Qa2JZgD" +
            "iiz5KQ0x+eXdw/kqJWFeS/TU+Tw6xUoWOMX5QwZUPzfQwPlOCjnRpUSD+VJG4ZkMcRv5WE04cGV/tvl2EB2qO1Hm+XcIigH9JuP5" +
            "jO61fFlhZvmXkp5uLMJG+awerg2x/2H5tDnhmhkQkvnCK2GC55Bg+crVy7tgctX5yw7c0mb8S/n1mdCqO1Hm+hPaw3Blf7b6RGZa" +
            "upu8kfpGuGxXc2hy+kfOJ4EJmYr6Y+mWOHQmS/qamqANleja+q0me4wN8eH6tlzDMbjsFvq3Gjn8losb+r+6MpapUA76xwMKQBjA" +
            "3PrMdKTs94mi+s28dH6m8Kz61yNvNKAUjvrc6T36DCe7+u3VnO9f63n6+sVFfQyjGPsubXWdk+nc+zrKC+aI9eX7O1+n2RUlmPtY" +
            "l5ADnbtL+11HKNWQA1n7XzZQ0DRxtftjk2/a6mJE+3MVdHDkf3r7gPbLwwFMFvuGnTD4zf+V+5ZEC2frCzf7mH4NNgpmUPug/Emo" +
            "tuPd+6jzmD6iVMb7q6UZePgsVfvGd8a4ASGt+8c6vYQr/oP7zfJ4UfOZHPvRyIFTTdy/++v165/HMqz79QJrNKAUjvv186X4gm0b" +
            "/AeF1Yzhx5/8HppaDeElSvxEibSotuPd/FHxvw2x/2H8UiwB8YQq2/xTfQJa/9wf/F0R+sTWlxD8bKsViRpLc/x0rtyYA4os/IHO" +
            "VlhvbP78g9dXjqDiR/yo6U1mb21X/K55qPqb0+L8sL4smAOKLPzBbQt9kaP7/NQtaFqh7M385kLMTcBAzPznaMFyzUkV/PgSQNVP" +
            "TIr8/E7onLZ5Iv0FcJUCxIHw/REmsQOdu0v9GBJ/w7K6+v0ZcG/02/F9/SAYJKo7Ueb9IRCRDPs++P0hvFQegJ16/TJ0CKax9079" +
            "Qhf/qKiKmf1Qr9+Ec0St/VD2EALEgfD9Via1DbH/Yf1eQeiWbwiL/XKdVpgDiiz9dN3Svwp63P2NkVcOfNeF/Zt+5niith79oWOT" +
            "WqHszf2+UsqEppdu/cJ4nkqhGIT98dYugQmZiv32gPKAPCPD/g3xnUNyPmD+Jn9MSlBQPf4teT/NQ7+l/jKwLMjh/ML+MsbJExwh" +
            "r/43SttqGXVe/jshiueOsZr+QJK4ejpKaP5RNVjTr4FS/mEiQPyWixv+cQsRQBjA3P5zgxpuLMJG/nmgd1R0i/b+fnvX2PlUkf6B" +
            "K3Y0oBSO/oUaU1JWFpr+hvFE/bYvwv6ViW9gxIs6/qTNTHlimxH+0Y6LkJbyjv7YdXydk+nc/uTSEuoy/ez++pGHFvCBBf8Nm3bX" +
            "QFo9/yr+0r9XRA//QEwSa5UTPv9BzcekTOV1/0KGFDJgXkn/Q2XwgBQlIv9LBFCotuPd/1WtIHj4LFX/WsN/ad9bb/9sDH+H1gaK" +
            "/3B/zbgBIa3/cULEh9YGiv970IhW9+TG/5X98p/HMqz/nwpyNKAUjv+lwxZ3Ec87/60/sp1gHNb/sY3ckIvPpv+0JIpjLwR0/8MO" +
            "1gOO6VD/yKJhEYstUf/VF30CGRnI/91CdRlX9Xz/+/nGDbH/Yf/9hQll/fQ0///ZI0M2PU0ABxoBudh++wALewA8KHe3ABazHIzE" +
            "U3oAK9ZdXBl1BQAt316SSupOAFBV4v1BxGwAUvFUahl1XgBdhitSYeO+AItjKIYumBgAn2W/tsAFYQCgSdOAJa87ALc5EytozKwA" +
            "t3OHVBf6HADCGobDsrr6AMN4dviF+YQAyxiYCVE28QDTT/txbYVsAOwgBqxSkqAA8i5Qw41KuQD0NpU/N9DAAPq35ogdTLQBAC68" +
            "DbH/YQEIVYaEppduAQqlu/AR8SMBHuXZtAxixwFLa5peS/TUAVJ2QoYumBgBWeG8ubb/rQFZ78T9QcRsAWd/a1Z52vUBm941gQmZ" +
            "igGmBcxAtguWAbf5pD/INlkB0cnzfflOjQHhUuJmb21XAe7pKklGcpYB9b63nZPp3AH2VJum65KKAfluc1R0i/YCCm9jsvs3GQIb" +
            "ExhAGMDcAiOoflR0i/YCKIPe3KNcmAIrM300oBSOAi8iWlJWFpoCP5F2XRqDMwJaehcDBuNRAl26DNWQA1kCanZZeVShUgJ08JuC" +
            "e34bAnuWkpCW8o4CjtoZ3zTl1wKYg47DjUq5ArejfdOWUjYC1QbZylVcJALqVBlvPxtFAuvVzqf27XwDFhSGhCv+gwMah9S4ASGt" +
            "AzCbtrsERNcDM5iXwvE4lQM+ckpFGPhMA0AF+Z/HMqwDSRJ5NKAUjgNgcBXQtdKVA2lElJgDiiwDcqpoFTU1WAN5OA2pU1BEA46Y" +
            "i/zYT2MDlvq2UlYWmgOmAc0Nsf9hA6eNEGJT7C0DqeEqRuBFVAOxIgi9gocCA9WgQ0C2C5YD1d5kX8N9DAPX52WV9PJVA+4cw0P1" +
            "8AsEAOOqy+3lUAQRjievUS8SBCqRjnL0TewEO047kJbyjgRDHlg2/CsRBETa1FZ52vUESW3GumoNaARKUdqDz7dCBFjDu7gBIa0E" +
            "YUEaK2jMrARhe45QbfIVBGwijcOyuvoEbYB97YfhbwRz2+ttMdugBH1YAm3DfWUEkHh40h1HKASWKA2hVHqLBJwu/nxZYWYEngVh" +
            "SqEYhASkv+19HzSfBLStwvAR8SMEyO3gt7ZqzgTPB5teLOO5BNMHcytozKwE4949aVb8eQTqIg9Yb2z+BOuUB2uVEz4E7YIpGoun" +
            "cwTuDkvSZvxLBPVzoVNN3L8FBsNgTGJfigUQoh82/CsRBRahC6o7UeYFF8AZSlBQPQVDPYP+FaDjBUPyv2H39IcFReY8gQmZigVx" +
            "NCkyoqCzBXghUno6SmgFfk+7/NhPYwWLWulxbYVsBZ/Gvp2T6dwFoFyio0GKgwWjdnpUdIv2BbR3aralPyAFzbCFVHSL9gXNv7HT" +
            "r4FSBdKL5dGlRIMF1TuENKAUjgXYNS/L7eVQBdkqYVJWFpoF2X3nNs1KCAXpmX1oGJtIBfJ/97L7NxkGBIIeBrDrWAYedJsToA/b" +
            "Bh74ooYlhiIGJZ6ZkJbyjgYuZ364ASGtBjjiIOLe7d4GOrNDBrDrWAY/tIvulprbBkxBKDu9v9YGYauEz+xKLwZnWVRy9E3sBm3o" +
            "D2JXAJMGfw7gxqtUHQaDzYPBnXC5BpRLm5HPH0oGlFwgcukjTAaV3dWc+NVnBqsRFsOXsOgGqyA7QBjA3AbAHI2PKhaYBsPDwFpC" +
            "f2YG4d3cVyhXkwbqDgCfxzKsBvMagDSgFI4HDIeHC1AfHgcOXKAW3hH+BxFVW7bABWEHJaUzib7JzQctY1vYfFkrBzigkvzYT2MH" +
            "Rbc7ov8FNAdQCdQNsf9hB1NzA3j4LFUHU+kxO+ItPwdow9i6m7yRB3zlVzYKZlAHge9smZ76XAeYJMpHn/gSB7uWLqunJwsH5Gev" +
            "06+BUgflVkKQlvKOB/N1za9r9VMH9Fnhh3m/SQf3moff5ns7B/wsaElGcpYH/pb3+pvT4ggCy8K4ASGtCAtJIStozKwIC4OVTMPq" +
            "DggTu0v9vkeaCBYqlMOyuvoIF4iE8THpdggfRSCpU1BECCdgCWoZdV4IKF8DNRKglgg2R5+6m7yRCDqg2ZHPH0oIPMcf8BHxIwhA" +
            "MBSk/oKSCE7H9IDJPKYIXrXJ8BHxIwh0Kt/u/T+tCH0PeitozKwIh3kXFgT7TQiSUsp/gKGECJQqFlTFZPcIlZwOZ+sLNwiYFlLS" +
            "ZvxLCJxnl6o7UeYIn3uoVvfkxgiq/0dYqPwKCK8kcC1Ce34ItaUTxJH9aAjAqRKqO1HmCO1FigG/qOoI7frGZaH8jgjyRFDxhCrb" +
            "CP9hI3L0TewJJR8T9KxR1gkoV8L82E9jCSpi/0bgRVQJNWLwbcN9ZQlFYrVXKFeTCUb6L3LPUysJSc7FnZPp3AlKZKmuP6KYCU1+" +
            "gVR0i/YJXn9xq6cnCwl3uIxUdIv2CXyT7NVPTIoJgiU1PbXk4QmDMmhSVhaaCYOF7jbNSggJjWsEgQmZigmRuZN8WWFmCZOhhGRu" +
            "k0EJnIf+tqU/IAmo2dPDjUq5Ca6KJfuy00MJxbyrY89LtQnJAKmJz44pCc+moJCW8o4J5LtKAwbjUQnpHTHU6oyLCem8kvJAouIJ" +
            "8mQ7+M3/lQn9AXOGLpgYCg+4L/yWixsKP+XcoKLdbgpK5pe9gocCClH/+f1BxGwKVShCQBjA3ApqJJSLgA6RCrVIA7sERNcKto+O" +
            "B6YXFwq7XWK6ag1oCs+tOo1o0dQK12ti3CZhMgriqJn82E9jCu+/Qp9U/S0K/XsKePgsVQr98Tg/jDVGCybtXjJgXkkLK/dznUkC" +
            "Yws8JhP82E9jC0Is0UtKABkLQz4ymuh8LgtDQbvwEfEjC2WeNbalPyALj15JkJbyjguZZiPNVbxMC5191LMV/VoLnmHoiyPHUAuh" +
            "oo7jkINCC6JVBYLnkGALqJ7+9vHL2wus08m4ASGtC7VRKCtozKwLtYPL/JaLGwu1i5xJGeIHC73DUvoUP5MLvgidkgeL3QvCwXPr" +
            "yVI2C9FoEGZvbVcL1jZT73NaPQvmzybwEfEjDAi90PAR8SMMG0DP0mb8SwweMubyp0e0DCcXgStozKwMMUFX4H1ykQw+Mh1fw30M" +
            "DD+kFXLpI0wMQh5Z0mb8SwxGFMPYI06mDEZvnqo7UeYMTLZX6+bfLQxQgKNZfJ81DFUHTlT+9AMMX60awOf1YQxqsRmqO1HmDG9A" +
            "P+xPPesMl02RBWmw8QyYAs1pTASVDKFZLw2V6NoMtw4r3LqrxgzPJxrxAknPDNJfyfzYT2MM1GsGQzY9TQznzOF3Ec87DO2/gR7y" +
            "5WkM8QI2dnlbMgzz1sydk+ncDPRssKqVmpEM94aIVHSL9g0Ht+4xuOwWDQiHeK9RLxINGAePqk4QcQ0jeghJ7TV4DS2N9TbNSggN" +
            "PL7TuAEhrQ09SSXnjrGaDUaQBaunJwsNTKNDfUW7WA1Ykiz/XNtKDV133KlTUEQNZl5t9NgMTw1vxLJneVO8DXMIsI15ljANdBjw" +
            "t44ycA19r5WAPCPDDYKs72nfW28NiNPv8T/mbQ2Ow1H/XNtKDZPEmfXqqukNlwSoudKxjQ2cbEL8eAecDayUt+Z+iq0NrNIEAsSB" +
            "8A25wDb8losbDcmfwAOdu0sN9O6eudh++w35Bp9GsK9/Df8wSUAYwNwOHMn7VHSL9g5eF8K50rGNDmCXlRKkLywOZWVpr2v1Uw55" +
            "tUGCarm/DnsGKG4swkYOgXNp39BpOQ6MsKD82E9jDpAGJ8Dn9WEOmcdJm6r1Jg6ngxF4+CxVDtD1ZS62VkIO1f96oPMKag7mLhr8" +
            "2E9jDuYvAJHPH0oO7DTYTvQIIA7tScLwEfEjDwgdq+yRs1UPD6Y8svs3GQ8Xtnwe8uVpDx/fW+sTEkUPKjf62CNOpg8tik/cuqvG" +
            "DzlmUJCW8o4PQ24qzVW8TA9LqpXnOotJD1KnBQHv4/APVtvQuAEhrQ9fi9L8losbD2TmVHcRzzsPZ8tZBRJXqA9syXroH0ovD4A+" +
            "WvMdYkQPkNct8BHxIw+d4h9QbfIVD8VI1tJm/EsPyDrt56kvnw/RH4graMysD9tJXuQnepgP6DokXBl1BQ/prBxvPxtFD+wmYNJm" +
            "/EsP7N2XevzopQ/u01Oq+lQZD+/wm3lUoVIP8HelqjtR5g/3dMsbBR2lD/qIql0mpzwP/w9VX/0MGBAJPB94+CxVEAm1Ib097VoQ" +
            "E3j/LxhaKhAUuSCqO1HmEDU2KZgDiiwQP1+77qhCsxBBVZgJE7j4EEIK1Gz2DJwQS2E2DZXo2hBMKVHkAuCjEFs+Cf1BxGwQYRYy" +
            "3LqrxhBkKCdcTh0uEHeE8qKUlUwQeS8h/ABh5BB8Z9D82E9jEH5zDT+MNUYQmwo9eiNjORCgCvec+NVnEMIPlq34GHgQxwZVUYvR" +
            "5RDXlfw2zUoIEObG2rgBIa0Q8JgMr1EvEhD2q0p5m7NRERnMuVx7O6cRLLT2ad9bbxE4y1j7stNDET3MoPmUsvARQdTjmMy6+BFG" +
            "dEnxee+HEVacvuookrQRW6ADdnlbMhFew7DQtdKVEWCxnIYumBgRY8g9/JaLGxFzoe97OFFmEXp1j3oNdh0Rfm7VI7frqRGARnNH" +
            "n/gSEZ72pcTWlxARow6mSlq3hhGpOFBAGMDcEb1xN5UisvERxtICVHSL9hHmpsLQtdKVEgqfnA76JyUSD21wsxX9WhIjvUiGFMHG" +
            "Eit7cON6cUASOg4uxJH9aBJDz1CYAO0fElGLGHj4LFUSXb2AhPr+OxJherp8WWFmEnr9bCsMTjsSe4LseVShUhKAB4GknRJxEpA2" +
            "IfzYT2MSl1HJ8BHxIxKtMGbgCVTwEr5/P2nfW28SxvFLfBvoVRLJ52LuvRpMEtMMf2l3J20S1FVLeF8yxRLXklbcuqvGEty0b4UI" +
            "fXUS5e4FbA80zxLrIEJwZX+2Eu12Mc1VvEwS9bKc6uSTUBL8rwz+RdvpEwmT2fyWixsTEdNgAWhPoRMVtbViBinHExbRgfMdYkQT" +
            "GkULvCt3FRMqRmHoH0ovEzrfNPAR8SMTR+omVBf6HBNXbrqC55BgE29Q3dJm/EsTckL061M3phOFUWXZKWKDE4dzZ6lTUEQTluWe" +
            "fqbwrBOaf6yqO1HmE6F80h6vJawTpJCxUiiPJxOpF1xcUwQRE7NEJnj4LFUTs70ouZPlUxO88z9xQ79mE8W767iBbw4TyMkr6BKo" +
            "vRPJTKPoEqi9E+lnwvJSSroT9Wk9DZXo2hQLHjncuqvGFBp6h7/VfxwUIzco+FZZ3RQoexQ74i0/FDhMuxNqHbQURRJEfc1rQBRK" +
            "Ev6got1uFFSi/lcoV5MUbBedovoAYxSQzuG4ASGtFJUQ3zw51SYUloELGa4fUhSgs1F18atKFKVf/4EJmYoUtf8DDZXo2hS2gAfN" +
            "VbxMFLewm1GL0eUUw9TAYCVDrhTWvP1p31tvFOvc6pUisvEU8HxQ9SP3jhUApMXfKnqfFQWoCnLPUysVDdBE/JaLGxUc+FuNaNHU" +
            "FR2p9neOSV8VKHbcJ2HzsBUqTnpD9fALFUKz00X2JhEVSP6swSyPCRVLNf80oBSOFU0WrU4Ev40VTf+2QtpMRBVVSpMPwBWtFWd5" +
            "PpjMuvgVbxSqGVf1fBVw2glUdIv2FXOFr+eOsZoVf/Sr0mb8SxWKtC14orYeFaoERW0x26AV2dR/ZZZ3RxXbOcuQ/hQdFd5oDjb8" +
            "KxEV5BY1uZPlUxXkxjwQ5A1CFhLPbl2psXgWJvtuQLYLlhYqD4ioRxp4FjSzYXwb6FUWOj4o/NhPYxZBWdDwEfEjFlLYeNIdRygW" +
            "Wc6xad9bbxZeEGmB+G7hFmTeEX82DdsWaIdGad9bbxZuvB0DnbtLFnPvaeO/AjcWdYE3qjtR5hZ+XVJ8CTrMFoGaXdy6q8YWl344" +
            "zVW8TBafuqPRPlsfFqCdu4EJmYoWpQp3XE4dLhazm+D8losbFsDZiO9zWj0WxE0Sv9V/HBbMjw9Ri9HlFtROaOvJUjYW8fItSRni" +
            "Bxb5FFJ4orYeFwii87nSsY0XGVjk0mb8Sxcau8u8uUbVFyA9uZIHi90XIGscExwhrxcks0cWBBdLFy9ZbNzTaooXQO2lc6jYlxdG" +
            "Zi8ZV/V8F0pP2a1oiqAXS4TZE7ENlxdOmLhV0pcuF1dU6TE6fiMXXUwtePgsVRdm+0ZtmbdfF2/D8rTXZwcXceHOjHKJiBdy0TLo" +
            "Eqi9F3NUqugSqL0XdxXXC4WOYhd3eB3qemxvF3xfBoSml24Xk2/J9fxSwRefcUQNlejaF6R/K1BL4NUXsdqDTC/9zBe1JkDcuqvG" +
            "F8SCjrwrdxUXy7afGyJ7pRfTIns2Hj7VF9fVG5Q1160X4lTCD8AVrRfjuxkraMysF/QbBaRM5XUYCjTzQioTBBgWH6SmpAhqGCnj" +
            "ABMcIa8YOtbouAEhrRg/GOY4j80fGECJEhYEF0sYSrtYckejQxhPaAaBCZmKGFCD7Ho6SmgYV8AL0lc/NxhgBwoNlejaGGCIDs1V" +
            "vEwYgMUEad9bbxiQ9QuJh8vPGJGjb2H39IcYleTxkXiq6hiX6agZV/V8GJgTJAOdu0sYqqzM4tSCphivsBF9zWtAGMcAYom+yc0Y" +
            "x7H9goxhdBjPQpmWqVAOGNF0J3cRzzsY0n7jDbu7fxjUVoFO9AggGPU+BjSgFI4Y9x60Ua7HlBj/UpoTah20GQQNjrqbvJEZEYFF" +
            "jc6i4xka4hBUdIv2GSR0+4T6/jsZKfyy0mb8SxlKLZNXKFeTGVe+IEqhGIQZW/rNdxHPOxldkcNUdIv2GXlCPwbFqQYZgCMLXorc" +
            "MRmD3IZpQH9OGYVB0pSoHCQZjh48vT3tWhmU8Kdn6ws3GZ31V3dS4J4ZrVeLVHSL9hmwvdFvKv9+GbPTMriGakQZw6pLqjtR5hnU" +
            "F4+r8SJ/GeZg/QIZGcgZ83QDfc7x/Rn+mxdJRnKWGhKPTWnfW28aHfdw52kKPhofiT6qO1HmGihlWXELIrcaK6Jk3LqrxhpJwqrU" +
            "6GMmGkqlwoEJmYoablUZtNdnBxqIfeG8uUbVGpv6NEzD6g4apBb7XizjuRqvi5fwEfEjGr8SO0M2PU0azrtOGa4fUhrhJYdllndH" +
            "Gur1rHdS4J4a9YzgF1sVnhr3v+xOpNn6GwTsH52T6dwbB1Q0ePgsVRsRA014l890GxIO4UqhGIQbFkS3FU0DMRsZy/m/1X8cGxuK" +
            "X9CH/K0bHNk56BKovRsdXLHoEqi9GyEd3gfbhlsbOJsoEpY0nRs9d9D5plrIG0ftVK5z+uIbUxXhGuXkQxtVxmbnjrGaG1sWV1JW" +
            "Fpobagdky+3lUBtuipW4gW8OG30qgjnIRtwbgd0il9/ftBuMXMkMFg2mG54jDKf27XwbqZt8kc8fShuvC9dpVvx5G7OXRwmGQkEb" +
            "tDz6PoAK/Ru/Yp9GbDC+G8FZF9mrT0Ub145rQBjA3BvlrF3SHUcoG+kg7UON5TQb6pEZIQIvYBv5cA2BCZmKHAHIEtYBRz4cCg8R" +
            "DZXo2hwKkBXNVbxMHBqNC1XSly4cHtVrZzSj4xwyAiU2/CsRHDurdmWh/I4cP+z4jc6i4xxQ6RFvKv9+HFm4GHojYzkcb8XoQVVw" +
            "eBxxCGmGFMHGHHG6BH7iWW0ccgNNdxHPOxx7qQ3vx+nfHHyG6hFlw4Ycfl6IS0oAGRyfRg00oBSOHKbwH3cRzzscqVqhCGwFnxy7" +
            "iUyReKrqHLum4w2x/2EcwHPnrWiKoBzUBLnSZvxLHP+4gkLaTEQdDCQ+DzJpOB0aI6M+NytSHSNKRgMboP8dLeSNbOqHVR0vSdmJ" +
            "qgQPHT74rmuVEz4dR/1ec6jYlx1XX5JUdIv2HW2yUqo7UeYdfh+Wr5sqhh2TNV49teThHZkkqNkVJZgdvJdUad9bbx3JkUWqO1Hm" +
            "HcrXhBLUxeod0jYc2CNOph3SbWB0tSq+HeA0F5CW8o4d4kgV/UHEbB3zyrHYkmstHfStyYEJmYoeC2a7nZPp3B4YTNRWedr1Hhhd" +
            "ILiBbw4eHWutHvLlaR4qEtPyQKLiHlmTnvAR8SMeYDfC2RUlmB5h/393jklfHmkaQkbgRVQebFMcudKxjR5sw764ASGtHnc/rNId" +
            "RygeeMNVHVgnWR6LLY5pQH9OHpMzqtOvgVIelms3kgeL3R6u9Cadk+ncHrsLVHTtx20ewEy+GPcLOB7D1AC8K3cVHsWSZtQyBLQe" +
            "xuFA6BKovR7HZLjoEqi9HsgYrtIdRygeyyXlEtmecB7UA4vTANv5HvCaexMcIa8e+dtr7E896x77w3FpVvx5HwUeXlJWFpofBW8v" +
            "UlYWmh8Ykpy012cHHyBvoW0x26AfIzWX/NhPYx8nMokuyi7HHyvlKYzhx58fNmTQCGwFnx9P7utcYaCQH1enpbqbvJEfV7pXXFME" +
            "ER9dn04NMEpIH15FATrWAvYfaWqmQsIotx9rYR7dVVdMH2ybShqLp3MfbZx7+hQ/kx+BlnJAGMDcH4a/Z227Eugfkyj0P+PdLR+U" +
            "mSAdWCdZH6N4FIEJmYofq9AZ2atPRR+tsBHwmrKsH7L+qZsdHlsftBcYDZXo2h+0mBzNVbxMH8SVElIojycfyN1yat6r6h/JellB" +
            "VXB4H8+79cd2HyEf0e+jg8+3Qh/ls31pTASVH+n553Blf7YgGxBwgmq5vyAc41PDjUq5ICTdq5tdTkMgJo7xFQ/LjSA6y1Ry9E3s" +
            "IElOFDSgFI4gU2KoDBYNpiBdhXVcYaCQIGE46rsERNcgYmJkcfunCiBlruoNsf9hIHmTA1zkbFQgfgzA0mb8SyCUWvbTyEgoIMQr" +
            "qjqNI0sgzVJNDhm5FCDX7JRwlI9cINlR4I1UDBYg6GcnZ3lTvCDpALVvPxtFIOnh3+9f63kg7Vtp4vM4yyDyBWV+pvCsIPY7c1ic" +
            "iQEg9wlAbTHboCEBZ5lUdIv2IRe6Wao7UeYhKCeds0UyjSExGW7Tr4FSIVULYQLgvhMhbJ/F/vb2xyFzmUyqO1HmIYo8HpCW8o4h" +
            "ndK43DxzNCGetdCBCZmKIa0QB9YBRz4htW7CnZPp3CHHmrw4qb2EIdGMr9j5VJEh1Bra7paa2yIDm6XwEfEjIgmH8xlX9XwiDAeG" +
            "ezhRZiITIkk74i0/IhnuulcoV5MiIstcIQIvYCIlEbcCxH8dIjFvG6i2490iNTWVbOqHVSJY/C2dk+ncIlzdKwBSWxMiZUPj3gUV" +
            "piJqVMUN+PMjIm+abckz7J8idS3sDy+WaSKvJmVSVhaaIq93NlJWFpoixCGPuAEhrSLNPZ782E9jItE6kDJ0Ns4i1JoGUmHjviLV" +
            "7TCQi8+mIviQ88d2HyEi+fbyXGGgkCL76RdKUFA9IwHCXl/9DBgjAdGjAe/j8CMHp1UCMjIzIwhNCDcr+u8jE3KtTcBAzCMVaSXS" +
            "Vz83Ixekgv2+R5ojK555QBjA3CMwx25qEQrhIzZZo/X8UsEjUrN1eJ6fjyNV2CDdVVdMI1keu5LiN6kjbp0ZXSanPCNy5XluiLPx" +
            "I3v3qoAlrzsjj7uEbPYMnCOUAe5wZX+2I5dKF3mbs1EjvemYEpY0nSPO5bKfB1ZKI9CW+Bi505QkB8Lrbyr/fiQPtvENsf9hJCOb" +
            "ClzkbFQkVKG/vFvt1SRuM7FFiztgJHdaVApvsQ0kj/Ok0LXSlSSSby5jz0u1JJMIvHLpI0wkk+nm8wnzgCScDWx6/OilJJxwDoEJ" +
            "mYokqLBRaVb8eSSrb6BUdIv2JLtHAxTgu1EkwcJgqjtR5iTHpfJSYeO+JNIvpLbvOpQk039Mjjia8iTb8m5ML/3MJOXmS6lTUEQk" +
            "9DR/7JGzVSUCo/YvGFoqJQ7Ft+9zWj0lNEQlkJbyjiVCJGAZH0XWJURQlbeOMnAlR9q/wpY7AyVIXWvA5/VhJUyV46QKiTAlVxgO" +
            "0lc/NyVfdsmdk+ncJXJM33cRiIcleb2Tzn04dyV7lLbco1yYJX4i4fmUsvAlo0ujPCh3tyWleywj4Rn6Ja2jrPAR8SMlssuPgjkv" +
            "lSW2D41+4lltJb0qUD+MNUYl0x0mIc6ucCXbdyKotuPdJd89nHCUj1wl4ab5te3QcyYDBDSdk+ncJgXmu8JAqDUmBuUyA/xjGiYO" +
            "XZmQFjDJJg9L6tpbDZ8mFFzMEaL7KiYZonTM3fSmJjUiaYmHy88mQUpXfR80nyZWfTfG5FsKJlkubFJWFpomWX89UlYWmiZbeLRM" +
            "L/3MJm4plrgBIa0md0Wl/NhPYyZ+U8v8losbJqP++VxhoJAmq8plVP70Ayar2ar+RdvpJrGvXAXcOjomvXq0ShY4xSa/cSzWAUc+" +
            "JsGsiQFoT6EmzV8vePgsVSbQzV+X39+0JtWmgEAYwNwm14g7cs9TKybaz3VmZwLaJt4vz81VvEwm4GGq+aZayCbuXu89teThJvpN" +
            "Y0pQUD0nCsLz2RUlmCcNtgtq3qvqJxZo27pqDWgnGKUgWXyfNScc7YByMrv4JyX/sYsjx1AnPgn1cGV/tidBUh59RbtYJ1GN9q1o" +
            "iqAneO25orFeUSeADu/wEfEjJ4e+6iwyy7wnltmvnZPp3CeiXvsDBuNRJ7m++A2x/2Env8NbNh4+1SfNoxFc5GxUJ+KnTzqNI0sn" +
            "670nPDnVJigU3QV8G+hVKBg7uEHhM1koHtdJ5iSMASg8dzVgJUOuKDy3E7m2/60oPfHt6AvbayhTqGGpU1BEKGVPChiKw1gofDer" +
            "uplCmyih2pajvn5kKLjNvvMdYkQozEXbS0oAGSjbK82Jh8vPKN5MLJCW8o4o5OOzUglcfyjphCapy4LgKOp6uZIHi90o8Li/P8g2" +
            "WSjx4sbGQEMKKPJlcsSR/Wgo9mf27JGzVSj2h+cNsf9hKPad6qBggSko/2/gqbWXJikBIBXdVVdMKQl+0J2T6dwpFxrr1ZADWSkl" +
            "nL3RpUSDKSgq6PXqqukpQBoDgQmZiilMSHedwxiZKVzTloXjN5wpYBeUgoxhdClvjcpBVXB4KXwXg0wv/cwphX8pqLbj3SmNCxPx" +
            "qzlCKa/uwsXqsDwpsO05B6ZrISm20hFSYeO+KblT8eVZJbQp4Gmby+3lUCnrUl6AyTymKgCFPsM6UwMqA4dEUlYWmioLoCfDjUq5" +
            "KgyQp8EsjwkqGDGduAEhrSoaKPXTr4FSKiFNrPzYT2MqKFvS/JaLGyouQRmQuuZTKjFUhUwv/cwqMs/PXORsVCpOBwBcYaCQKlXS" +
            "bFio/AoqVeGx+pvT4ipoL6eaGRCSKmu0kAUSV6gqd2c2ePgsVSp5KS7DjUq5KnrVZpQ1160qgZBCdnlbMiqE13xivPrTKog31s1V" +
            "vEwqimmx7qhCsyqMv/tRi9HlKo4biuYkjAEqrEAPNRKgliq3vhJnNKPjKsBw4rbABWEq0Ae4h3m/SSrcR0voEqi9KuLb5TbNSggq" +
            "6BH8cGV/tirrWiVyR6NDKwDIskpQUD0rGK58wS1AMishqdllWNvLKyL1wKZbZlgrJYkVbizCRisqFvbwEfEjKzDon1xhoJArMw8T" +
            "ptuc5StA4badk+ncK0xnAgaw61grXQkDejpKaCtpy2I5yEbcK3erGFzkbFQrjK9WPjcrUiuVxS44j80fK7lNt5CW8o4rykhz+FZZ" +
            "3Svg8+ObXU5DK+Z/PFx7O6cr5/n067XjciwDgTuotuPdLA9XEQ2Mq0MsJj+yvkNKoiw/6d9tar0XLF+lb81VvEwsYtXF6B9KLyxo" +
            "p4W8uUbVLHZN4k70CCAsglkqVOuiPiyI7zLg41G0LJrAxkNyPmAsm+rNyepLESycbXm5k+VTLKCP7g2x/2EsoKXxnLZ5IiypTjTs" +
            "kbNVLKsoHNmrT0Usq6SbxWbAxyzBD4KGLpgYLMVYHhqLp3Msz6TE1U9MiizqIgqBCZmKLPZQfqFtIKAtBtudeuUfhy0a6I+YA4os" +
            "LSTr0no6SmgtKgMTGHzH8S0vhzCotuPdLTBRaD215OEtNxMa7gExOy1Vh994XzLFLVn2ybrsmCctWvVAC1BzKC1jW/jhrx2tLXEQ" +
            "H37iWW0tkJX/UEvg1S2VWmWEc0StLaqNRc44axgts1rTuOan3S22mK7E1pcQLb4/U6i2490twjmkuAEhrS3SY9n8losbLdzX1lzk" +
            "bFQt4U9z/NhPYy3jTr/xMel2Le1d5IA8I8Mt8tuJubb/rS3/6bj28cvbLhI3rpZvCIsuFqGlXGGgkC4XpmeyNTd9LiFvPXj4LFUu" +
            "JN1tkIvPpi4rmEl6I2M5LjI/3c1VvEwuNHG48lJKui43YztcYaCQLj1kpl1evZguQTmf/JaLGy5JfrrOfTh3LlNQYEO8ch4uVkgW" +
            "NRKgli5bsl/cuqvGLmHGGXIyu/guanjpsxX9Wi5ucxzZFSWYLn+QuUlGcpYuhk9S6BKovS6JYzcNlejaLpViLHXxq0out9uzkJby" +
            "ji7LHZdwZX+2LtQe/fAR8SMu2vCmXGGgkC7dFxqqhaTsLurpvZ2T6dwu9m8J+7LTQy75iqIg7TLcLxPTaS7KLscvIAg78vulhS82" +
            "t11B4TNZLz2c73Dkf3ovPxXiSycZDC8/zTVDjeU0L07NrMONSrkvXeyX/Y+PFS9jVb6QlvKOL2jGSn+3TswvdFB6/ABh5C+CIZnw" +
            "vgvrL4r76p8HVkovrYlCqLbj3S+1fK0ft0UvL7lfGBE2s0ovyIOJE3rGAy/J9rp8G+hVL9BHucHtUqkv0MFqPbXk4S/p8eZxFMUe" +
            "L+q6+1Jh474wAU4r4t7t3jAFPCe2wAVhMAYDmw2V6NowCa12zVW8TDAM3czryVI2MBtGeZHPH0owHF4rTpctNTAgVelD9fALMC59" +
            "yVDGdYMwPxnd0h1HKDBEyM04dCZLMEXy1M2UUxgwRnWAvT3tWjBKl/UNsf9hMEqt+JkMcRswTyQL/hWg4zBP3IZ5a6SwMFWsoskQ" +
            "yM4winiu0h1HKDCTpETmJIwBMJQqEYEJmYowoFiFlm8IizCw46R+jyeOMMM5P/GEKtswxPCWmAOKLDDF0xBpVvx5MMb2NJ/HMqww" +
            "yO8ju2By1TDMJLXDjUq5MOEbIfj/SVAw/4/mfAk6zDEAaSIToA/bMQP+0L6WoC4xFLJVlqlQDjEbGCaCjGF0MT9ibIgdTLQxRGIU" +
            "zn04dzFJYuPoEqi9MVSVTMqOYxExVKPv/NhPYzFap4pRi9HlMV1i2ryQr+QxYKC1udh++zFmC4s1EqCWMWhHWqi2490xeZ5aSUZy" +
            "ljF8a+D8losbMYbf3VzkbFQxi1d6/NhPYzGNICJPbjOkMY1Wxu2H4W8xksl2UEvg1TGhSJoai6dzMbEb3NgjTqYxvD+1oW0goDHL" +
            "d0R4+CxVMc7ldIzhx58x1aBQfc1rQDHcR+TNVbxMMdzPskT0KGwx4WtCXGGgkDHp04d8EMjvMetBpvyWixsyAFAdNRKgljIC41GA" +
            "PCPDMgW6Zty6q8YyC84gboiz8TIUgPCva/VTMidRy1JWFpoyLfvb71GdfjIwV1noEqi9MjNrPg2V6NoyNhkPCYZCQTI4rmSJh8vP" +
            "Mji3eomHy88yYeO6kJbyjjJkXq4QjytgMmS1Q/JSSroydSWecGV/tjJ4vUJUdIv2Mn4nBPAR8SMyhPitXGGgkDKHHyGfh4zXMpTx" +
            "xJ2T6dwynn8DWx1weTKgdxD/XNtKMq1PjtA7xcYyvdtwMnQ2zjLEk2/zHWJEMsoQQvalrYwy0K0s0h1HKDLXCDdcUwQRMuC/ZEWL" +
            "O2Ay56T2bTp3czLp1Tw/490tMw1dxZCW8o4zDpyXgDwjwzMeWIHxAknPMyFEVd0KK68zNQPxorFeUTNXkUmotuPdM3PyE59U/S0z" +
            "ek/AxZdasDOG+zaJNWrYM5P57XS+zSUzq1Yy3zTl1zOvRC66ag1oM7ALog2V6Nozs7V9zVW8TDPGZjJSQTU8M8pd8Eef+BIz0TEX" +
            "uAEhrTPROd13Ec87M9lbExdbFZ4z6WK34H1ykTPu0NQ8Hi5SM+/627PuGucz9J/8DbH/YTP5LBIBv6jqM/+0qcy60NU0BdaSYmAs" +
            "HDQdwTq8uUbVNCkAQwFoT6E0Lpj8XORsVDQ4H/OcTWtJND4yGIEJmYo0Qp87DZXo2jRIlqK5tv+tNEn4dK1oiqA0SmCMmhkQkjRP" +
            "zMc/N9DANGUEf7L7Nxk0Z2sPNRKgljRu+J2YA4osNHCflVBiYwc0cvcqvwp63DSI0Z8VTQMxNIsjKPVVQUk0mlvmePgsVTShJb+t" +
            "+Bh4NKmX7XELIrc0xSAtd45JXzTzauroEqi9NPzuM6o7UeY0/qv2/NhPYzUBKRlKUFA9NQdq4bGSl881Cqi8vYKHAjUQE5I1EqCW" +
            "NRJPYai24901FnQbAipAmzUcZAlCf04LNTDn5FzkbFQ1NV+B/NhPYzU3Xs34hfmENTms2lZ52vU1Ra+0UEvg1TVYt4eotuPdNWNy" +
            "jW8q/341Zke8ncMYmTWLc0lcYaCQNZPbjn+60PY1lUmt/JaLGzWdIs9SYeO+Naco9w76JyU1qlgkNRKgljWvwm3cuqvGNb+mwygd" +
            "kyc12APi66eVdzXaX2DoEqi9Nd1zRQ2V6No14CEWDTBKSDXrsgS3jjJwNgV0JTb8KxE2C+vBkJbyjjYOvUruqEKzNhAdJ3xZYWY2" +
            "Hy2lcGV/tjYjjZdAGMDcNi8AtFxhoJA2MScoozGU3jZIhwpex3iANm6bdu9zWj02dBhJ66eVdzaBED5f/QwYNpGs/Xg4j4g2pi9u" +
            "TC/9zDapJmvxhCrbNrdlzJCW8o42uF5a30nFhDa+JJd9DKMYNshgiPSsUdY23wv4pltmWDbhAKJf6HosNuXuEAYcyF42+mCnad9b" +
            "bzcBmVCotuPdNx36GqL/BTQ3II5HbZm3XzcipwW6Vi/vNz4B9Hho1Sw3QIS806+BUjdVXjnqMv3sN1lMNa9r9VM3WhOpDZXo2jdc" +
            "K1py9E3sN129hM1VvEw3YDBEUYvR5TdtdZcxuOwWN3BuOUdDHSc3ezkeuAEhrTeDYxoTsQ2XN49MO4m+yc03k2q+5Cd6mDeaAuK3" +
            "mCLuN6Go9LsERNc3ozQZBWmw8TepvLDQZNjcN9MISgUSV6g32tTFrWiKoDfsp0INlejaN/BZSzrWAvY3+dTOPzfQwDgAZb/O8wVh" +
            "OA8MhralPyA4EXMWNRKgljgZAKSYA4osOBz/MbQMYsc4HipPeWKbETgh/8w+qSI6ODLZphj3Czg4Sy3Gqk4QcThTn/R0tSq+OFzy" +
            "15D+FB04Zu+fPzTNwThvKDR7OFFmOHwvYILnkGA4fkXpbizCRjiHIO56OkpoOJ1y8egSqL04pvY6qjtR5jios/382E9jOLFy6LU8" +
            "n9Y4uhuZNRKglji8V2iotuPdOMB8IgXUSKI432eI/NhPYzjhZtT02/F9OOdYNnj4LFU46UO4kFuiQDkCv46otuPdOQzSj/zYT2M5" +
            "Kxmlupu8kTk1e1BcYaCQOTWCW2nfW285OaP7ZzSj4zk945WDZNj9OT9RtPyWixs5UTD+EqQvLDlZynTcuqvGOXxOA8arVB05ggvp" +
            "9qWtjDmHe0wNlejaOYopHQIyMjM5lFlwbyr/fjmmbX3VkANZObMn7yvePO05tfPIkJbyjjm4xVH5plrIOb+g4ytozKw5yTWscGV/" +
            "tjnMsQK50rGNOc2VnkAYwNw51KYbgjkvlTnfaBNuiLPxOfKPEVPJYGs6E8RGqLbj3ToYo33ryVI2Oh4gUO9RnX46IX88LMl6Yjol" +
            "xfq8zVDyOisYRVT+9AM6O7UEdI6HgTo/StsDnbtLOkP6c5apUA46aCyeeWKbETqPpuN9iQgROqRormnfW286tKXDkNpMZzrIAiGY" +
            "AO0fOsmjEHiith46ypZOcUO/ZjrR5SJ5VKFSOvxl+/zYT2M6/2ZA5oj15TsDVDyzFf1aOwQbsA2V6No7GnZASu0lLjslQSW4ASGt" +
            "OyVUNrsERNc7LWshHq8lrDs5VEKNaNHUOz1yxdkpYoM7RArpu0Iq9TtNPCAJE7j4O3GYZFxOHS47fRBR+hQ/kzuWr0kNlejaO5ph" +
            "Ujcr+u87o9zVPzfQwDuqbcbSnQ1oO7kUjaunJws7u3sdNRKgljvHBzi3tmrOO8gyVn0Moxg73OGtDfjzIzv1Nc2mpAhqPAb63pSo" +
            "HCQ8CG+fXWdQxTwQ96ZC3tXIPBknU+WYqpk8N6lbAsSB8DxHevjoEqi9PEsZ6P1BxGw8T2AfqjtR5jxQ/kGqO1HmPFK8BPzYT2M8" +
            "ZCOgNRKgljxqhCkJflCpPIIyMXiith48pQYVw41KuTypK+mJh8vPPKzHlai24908ttqW/NhPYzzRBAxpVvx5PNZ290oWOMU83TQ9" +
            "QVVweDzfimJp31tvPOOsAmreq+o85+uchw7hBDzoW4C9aEBWPPs5BQemFxc8/O5HB6YXFz0NMpdKUFA9PRljdwfIsA09IdTV546x" +
            "mj0mVgrKVVwkPSZ3WxE2s0o9J0YDejpKaD0sE/Dy+6WFPTQxJAXcOjo9N+ijEpY0nT0+FHg4A2/mPVo2ZW4swkY9Ys1Y9fxSwT1k" +
            "ulMraMysPWmo6itozKw9bB97wrS71T13naVAGMDcPX6uIoXjN5w9iXAacjK7+D2YW/hJRnKWPZyXGFdzaHI9nPCuhzJyqD2yW6/w" +
            "mrKsPcKrhOgfSi891SBMWKj8Cj3Y9s98CTrMPfgDWKSgJS4+EjSldbiTCj4qGTu++thtPk5wtWnfW28+Y90PlBhjiD5yCiibqvUm" +
            "PnSeVXTtx20+f1h3NKAUjj6AkMoCxIHwPox2YXcRzzs+k/L93EbQIT6a19WiFbe/PqZuAvzYT2M+qcIhQnWcmz6sCYrOfTh3Pr70" +
            "ZhKWNJ0+z0ksuAEhrT7XcygbBR2lPuNcSYJqub8+53rM3NNqij7uEvC+7DL8PvIuS/1BxGw++Wij7lmyQj8j4P7YI06mPyUIDuxP" +
            "Pes/JxhY/b5Hmj83CS08KHe3P0C3UA2V6No/RGlZQioTBD9I21ONVAwWP03k3D830MA/VHXNx571Uz9i1CfDsrr6P2MclK9RLxI/" +
            "ZYMkNRKglj9uLTs+gAr9P3IWc4YumBg/cjpdcg6LAz90y6TD8R+iP4bptBGi+yo/nz3UovoAYz+qzJeVIrLxP7EC5YmqBA8/t80X" +
            "QHGJDz+6/6034L2zP8QaH5F4quo/xRWnQBjA3D/Y4ZuEppduP+8I0cONSrk/8syiXGGgkD/5aCaqO1HmP/sGSKo7UeY//U5sejpK" +
            "aEADAJ6Rzx9KQBSMMA0oWLBAHzx/0mb8S0A5KY2GLpgYQECVB7m2/61AQKMPPCh3t0BWz5yotuPdQGA6/Dwod7dAYOKd/NhPY0B0" +
            "S+vmb7BKQHxuF8VmwMdAgH7+TcBAzECJkmlp31tvQIy5F0C2C5ZAjbQJboiz8UClQQwLUB8eQKb2TgtQHx5A0F4Rv1dED0DQf2IN" +
            "jKtDQNWcdUlGcpZA3Xm76xMSRUDhmSYDnbtLQOaWG/jN/5VA9sbPlKgcJEEOwloraMysQROw8StozKxBFieCxl7D3EEhpaxAGMDc" +
            "QSi2KXrlH4dBMAdr0mb8S0EzeCFnNKPjQURtV5apUA5BXGO28JqyrEF/NtmEppduQYL+1nhfMsVBpZPXQBjA3EGoy6gai6dzQbw8" +
            "rHIOiwNB44dvemfYRUH4eLxp31tvQgaa22nfW29CDeUWkG5bgUIXTwG7BETXQh6mXHiXz3RCJSWVg/+rl0JQdgn82E9jQlqvnsd2" +
            "HyFCbjh3lhuT8UJ3OyQvnMASQn7Vpz/INllChjiLAxug/0KNZFCGFMHGQqNwquqvqjtCypS7vpagLkLUjkRwZX+2QueW9cvt5VBC" +
            "7nFgPoAK/ULy41qJqgQPQv591MtI/VpDAG2gHvLlaUMM3C7Dsrr6QxFE2XL0TexDEji6MnX+9EMYNUJCKhMEQxxCZHW4kwpDHOLY" +
            "546xmkMp0aM2/CsRQyuOH1Z52vVDNNCvVHSL9kM7+st4+CxVQ1TUnpjMuvhDWwrsjVQMFkNd+suQlvKOQ2HVHkQbkRZDYptIubb/" +
            "rUNlB7Q7isW6Q24iJo3OouNDbx2uQBjA3EN3K8PSHUcoQ4LiSXxZYWZDo3AtqjtR5kOwuhftd7uYQ7w9NhOgD9tDyUSG0mb8S0Pt" +
            "dquLSRLVRArqpPzYT2NEEYNPf7rQ9kQeU/LixahDRCZ0c4J7fhtEJnYeyRDIzkQqhwVCwii3RDOacGnfW29ENQ0IPzfQwEQ3vBBy" +
            "Mrv4REIvp1JBNTxEUP5VDvonJURe1J16OkpoRGQB6Jd0BoZEemYYwwFMFkR6h2kYisNYRIeBwu69GkxEkJ4i/HgHnESRZ8fhrx2t" +
            "RJssHOxPPetEoM7WkP4UHUSx13ffbYUtRLjKYStozKxEvbj4K2jMrETAL4m7YKvHRMJJFMj9a5JE0EhbMnQ2zkTSvjB+jyeORNRp" +
            "Z5BuW4FE2g9y0mb8S0TdOohuQuk+RN2AKGreq+pE4ohedxHPO0T4rorNVbxMRQZrvfCasqxFCPkglqlQDkUQv8/pzbORRRISMkpQ" +
            "UD1FHBv36v5T5UUtBt10tSq+RS4CCw2x/2FFMvRzeqRzIUU2Nxvhrx2tRU4Mn3L0TexFT5veQBjA3EWFc149teThRY2Pdn4R4ExF" +
            "kcRhAn5kM0WqdwuZKTKxRbCi4mnfW29Ft+0djMRTekXC1yzDjUq5RciRJ1coV5NF5an/0955vEX1D+tVxMVJRfp3x/yWixtF+n4Q" +
            "/NhPY0X/ilvQNHG1RgvxX5RSmSdGGEB+mcWb+EYo3a5Dcj5gRjBAkgbFqQZGMwXQIlBWyEZNeLH1rcJQRk93I7qbvJFGV1m3uAEh" +
            "rUZ0nMK67JgnRpzrYZSoHCRGtuQ1w7K6+ka6oMJC2kxERsI9STcr+u9G2iSU917sLEba2nyAoHKCRt7YtlR0i/ZG4t+zSUZylkbm" +
            "AtJ4+CxVRv7cpY3OouNHBfhrqVNQREcIAtKQlvKORwvdJUfFmR1HGCotmMy6+EcZJbVAGMDcR0zXgHlUoVJHTXg0qjtR5kdTCKMN" +
            "sf9hR1rCHunNs5FHc0yN0mb8S0d5BhW+Z1TPR5XXu2wpLslHnh+OK2jMrEe7i1Z8EMjvR8hb+e3DwFhH0Hx6hiWGIkfQfiXMutDV" +
            "R9SPDEZsML5H2Peb8YQq20fkUVsPwBWtR+w3rk6XLTVH+wZcEqQvLEgUiE9qMuBpSCSPcBTgu1FIMYnJ478CN0g2jsrDjUq5SDqm" +
            "KfF574dIO2/O5VkltEg7jNtq3qvqSErW3Y1UDBZIW99+4xeNNEhhnQOUNdetSGLSaCtozKxIajeQvwqzzkh6UGIuyi7HSH5xbpQY" +
            "Y4hIhBd50mb8S0ist+SJh8vPSLBzxPCasqxIusfW7Xe7mEjFELdGbDC+SMYj/u6oW+xIx5hjXGGgkEjTzzv0Ks00SNcO5HELIrdI" +
            "2AoSDbH/YUjfIUOqlZqRSOA/IuVZJbRI+aPlQBjA3EkYv765tv+tSR37M/MJ84BJMa1DxNaXEEk3l31zE8g3SVqq6WnfW29JYA7X" +
            "cRTFHklh9SSJGktzSXgdmw2V6NpJhzAY7E8960mPsgbQNHG1SaR/zvyWixtJqZJi0955vEm1+WaX/KEuScJIhY7Hg+NJztEC2RUl" +
            "mEnS5bU4dCZLSdpImQpvsQ1J94C48gO6SUoBYb64ASGtShsoO1zkbFRKHqTJxeqwPEop8X3Zzy95SkbzaJD+FB1KUV3uejpKaEpW" +
            "SRhuLMJGSmDsPMOyuvpKaWrjDYyrQ0psRVA61gL2SojgvVR0i/ZKkArZePgsVUqjWbDDjUq5SqjkrJF4qupKsgrZkJbyjkqzXd5F" +
            "QjFoSrXlLEtvoSRKwjI0lSKy8UrDLbxAGMDcStHDjAKA5MpK48qwdxHPO0r9EKoNsf9hSwTKJeYjq4pLHVSU0mb8S0s4GI50aerw" +
            "S0IqlPde7CxLQpKDDy+WaUtlk12HDuEES2a1AzbNSghLcmQA6hm4UUt6hIGJz44pS3qGLNBk2NxLjlliE2odtEuWP7VK7SUuS58c" +
            "cFxOHS5LvpBWbdzocEvY/OSp55daS9uR0OdpCj5L5K4w9SP3jkvld9XaWw2fS+WU4mc0o+NL7ms5MbjsFkv03uSJqgQPTAXnhdgZ" +
            "dR9MCi1TiNPow0wLpQqX39+0TCRYaTnIRtxMKHl1iRpLc0wtHEI/N9DATC4fgNJm/EtMRCsnqVNQRExazDu3jjJwTGTP3eJ5o4NM" +
            "bxi+QsIot0xwLAXjqkPXTHGgalxhoJBMcp+DePgsVUx9t/O50rGNTH3XQvCAxS1MghIZDbH/YUyJKUquP6KYTIpHKdpbDZ9Mk4VP" +
            "AsSB8Eyjq+xAGMDcTLBTCwOdu0tMyAM671/reUzKqaYdd02WTNu1SsEsjwlM4Z+Edr3QPk0EsvBp31tvTQoW3m1qvRdNOboNzIpp" +
            "rk06q0B4orYeTUTLDbnSsY1NTofV/JaLG01SG7PyQKLiTVOaacjgYadNYAFtm6apNU1huXNuLMJGTWRGzpapUA5Nais+Exwhr01s" +
            "UIyScYvqTXztvDweLlJNhFCgDhm5FE2GAGsHphcXTYdqtlZ52vVNq2nFuAEhrU3FMEJc5GxUTcis0MJAqDVNyjZ/Ns1KCE3M4kvQ" +
            "tdKVTdSJbw8vlmlN54UXDZXo2k34uJnwmrKsTf4HMhSBcBxN/mnHHvLlaU4Q60XYI06mThNy6hE2s0pOF8yYAhkZyE4y6MRUdIv2" +
            "TjOvrzJgXklOOhLgePgsVU4+lC+otuPdTkuZn3cRzztOXBLgkJbyjk5oRjSC55BgTmrlROmgftJObopAs8aTFk6nGLENsf9hTq2P" +
            "8vrl+VVOrtIs4nmjg060dGtSVhaaTso5058HVkpO3cHMXizjuU7smooS2Z5wTwB6zEFVcHhPDR7aVnna9U8Pm2SDZNj9TxC9CjbN" +
            "SghPEvEA7JGzVU8ZbfBwiJWOTySMiI15ljBPJvk74H1ykU8yfB+BCZmKTzhhaQhsBZ9PQEe8R0MdJ09VZ3y5fEJST144PeF7SJdP" +
            "YSFkx3YfIU9omF1i3tBbT3MPM/GrOUJPj3/c3gUVpk+PnOlyMrv4T6/vjNvDfSZPta0RjOHHn0/OYHA2Hj7VT86iBPzYT2NP0oF8" +
            "jMRTek/uEzhBVXB4T/Fig+QnephQBiVq0ZkyfFAO1+TmI6uKUBkgxU3AQMxQGjQM51RL3lAbqHFcYaCQUByninj4LFVQIY6gfTb5" +
            "blAlpAwBmpsSUCffSezWvSZQLBogDbH/YVAzMVGjQYqDUDRPMN4FFaZQRXb7kc8fSlBHZOeGLpgYUEgvI6o7UeZQcgtB67XjclB/" +
            "b9qHeUoKUIW9Ub2ChwJQk8c2bTHboFCo//GotuPdULQe5Xho1SxQvRKa917sLFDK0cjL1xm2UM1aDZHPH0pQ48IUyOBhp1D4j9z8" +
            "losbUPwjuu6WmttQ/aJwzIpprlEKCXSfULE8USXMZBKWNJ1RL51acvRN7FEwCHILUB8eUURwy4T6/jtRSC4FfFlhZlFLjO9cUwQR" +
            "UVVxzLgBIa1RYjY3eVShUlFvOElc5GxUUXQ+hjbNSghRfTQOUL5RZlF+kXYS2Z5wUZGNHg2V6NpRk+OxHvAIO1Gs+/PwEfEjUb16" +
            "8RTgu1FR3be2NgpmUFHonDaotuPdUhiDgz830MBSHvar+hQ/k1InQNPnaQo+Uj4iBYLnkGBSQitbgQmZilJRILgNsf9hUl58clJW" +
            "FppSdEHam11OQ1KAQOvoEqi9UoCzFuyRs1VSlqKRB9uGW1K6xRE2zUoIUtEBQuQnephS3IQmgQmZilLiaXAMFg2mUvXJm5/HMqxS" +
            "+7ZvzN30plMSoGRmiNhiUx0XOu4BMTtTHU7ncRTFHlMrd3MeryWsUzLkW/AR8SNTNkOioXT1/FM5pPBuiLPxUztWSVcoV5NTPXmL" +
            "YCVDrlNHsiNjz0u1U1VNxu7JFpBTX7UYkIvPplNtaOMbBR2lU5tqiuB9cpFTwyjMShY4xVPFsHhcYaCQU8avkXj4LFVTx/+4ca3j" +
            "PlPR51DpLLUfU905WKbrkopT4BQ7FgQXS1QLYZzZAtkMVBv2PtgjTqZUHBNI6Avba1Qcfh82zUoIVCym7+UtyO1ULy9f5VkltFQv" +
            "xVi52H77VDSzAULaTERUVcf1GVf1fFRWIpxyixq2VF4m7HS+zSVUfT+mt44ycFR/pGh3Ec87VJBt27jmp91UpivB+ZSy8FTFG1k2" +
            "/CsRVMt5h0/KwI1U2hB5DvonJVTuMXyEppduVO63YHwb6FVU9ZT2X/0MGFT5grmckGTDVQOYC3S1Kr5VDa65QLYLllUQFPfVFqJ3" +
            "VRPYJuRp2WBVGUBQXORsVFUc2882Hj7VVR5GjTbNSghVIo9oPbXk4VUlGJr3XuwsVSiZfQfbhltVKcPg5FPtplU5i8PSHUcoVTuV" +
            "JQ2V6NpVZ4L4GIrDWFWDH7c/N9DAVYe/vSsMTjtVkqQ9qLbj3VWVTudDcj5gVa8Qz2oy4GlVwouKPzfQwFXI/rL9vkeaVdFI2uO/" +
            "AjdV23Sn2HxZK1Xfx514orYeVfFjcIAUJSJWBx5nExwhr1YIhHlSVhaaVhF78/zYT2NWHknhpltmWFYqSPLoEqi9Vi4ZPG4swkZW" +
            "QKqYC4WOYlZYlRnLWTzTVmMSUcONSrlWZM0YNs1KCFZ7CUnZKWKDVoaMLYEJmYpWn9Gin8cyrFalvnbJM+yfVq9NK9Jm/EtWvEUL" +
            "/JaLG1a8X8d0joeBVscfQfj/SVBWx1bubWq9F1bI3BxC2kxEVtV/ehsFHaVW3Oxi8BHxI1bd9CtSVhaaVueBklx7O6dW8boqZ3lT" +
            "vFcGhzI0oBSOVxCWSxMcIa9XF3DqHq8lrFco/9RSVhaaVzc3N3o6SmhXRXKR3NNqildwt5h4+CxVV36c8xlX9XxXfsZvA527S1eD" +
            "s5NSVhaaV4ocQhmuH1JXrMvMlqlQDlevUoBQS+DVV8aGJjbNSghX1q726NfQ9FfZN2bhrx2tV+rA2bqbvJFYCR6keKK2HlgSetvN" +
            "VbxMWDp14ryQr+RYPnFriYfLz1hCj5L8Do88WFAzyPXqqulYeWkqy+3lUFiEGIASpC8sWJDhH7wrdxVYn5z9VP70A1iqINOGJYYi" +
            "WK2gEnELIrdYs0MyG4GoNFi6HP7YwKp+WMbj1jnIRtxYyE6UNs1KCFjSoYQLhY5iWNNmx/zYT2NY5Z0sDZXo2ljoyu/qMv3sWRvg" +
            "ODMbQAZZLQonzLrQ1VktJ74/N9DAWTHHxC62VkJZPKxEqLbj3Vk/Vu4/yDZZWUKB4Ly5RtVZTzVMMbjsFllZGNZt3OhwWWyTkT83" +
            "0MBZcwa5AWhPoVl1sbwe8uVpWXtQ4e69GkxZhXyu3CZhMlmFlssD/GMaWYv3r0QbkRZZsoyAUlYWmlnBgfDL7eVQWchR6KKxXlFZ" +
            "0QTa7E8961nUUPnoEqi9WdYpW5gDiixZ3nM3jYuNRVofTnPTr4FSWiD3S/CasqxaJRFQ3NNqiloqLIa3jjJwWi6gn+1ari1aMJQ0" +
            "gQmZilo8ebHnjrGaWknZqZ/HMqxaT8Z91DIEtFpQuq/L7eVQWmZNEvyWixtaZmfOeDiPiFpxJ0j1VUFJWnFe9Xho1SxaeLEOeVSh" +
            "Ulp8Dx9miNhiWn+HgRdbFZ5ahvRp8BHxI1qH/DJSVhaaWpBOx9C10pVakYmZZ3lTvFqbwjFcezunWqM7CHAhMW5aruvjYlPsLVq7" +
            "pf+dwxiZWsF48ROxDZda73qY2Slig1sdFJZQS+DVWyiSVxGi+ypbLbuaUlYWmls0JEkdWCdZW012V7gBIa1bVnkzgDwjw1tbfjtm" +
            "aiCGW3COLTbNSghbe+6XqLbj3VuAtv3d2bjfW4M/bd4FFaZbsEsH3GqyhVu8guLNVbxMW9T+pmwEZchb5DjXyRDIzlvkfemxkpfP" +
            "W+ZrzULaTERb8teJThkcg1weqE4CGRnIXDOdWwwWDaZcOukmv9V/HFxJpQRYqPwKXFQo2oJ7fhtcV6gZfAk6zFxkJQXcarKFXGVS" +
            "LCbI7fBccIacfFlhZlxw690uyi7HXHnoqT215OFcfW7O/NhPY1x/1/PZFSWYXIECM17HeIBcktL25oj15Vyxis9Ru3k1XLjpZ9gj" +
            "TqZcuaHS/Rn9JFzASYvcuqvGXNcSLtBk2Nxc1y/FPzfQwFzpXvU8Hi5SXPSbI6NBioNc/wAfVnna9V0DIN1i3tBbXRabmD830MBd" +
            "GwU/NKAUjl0dDsAFEleoXSVY6OsTEkVdKYO/zVW8TF0vLLZBVXB4XS+Etd/QaTldL57SAFJbE101/7ZAcYkPXTZLjNWQA1ldRusN" +
            "2RUlmF1TBme50rGNXVsQloT6/jtdXfL30h1HKF155vUSljSdXX5ZAOgSqL1dgDFimAOKLF2tAVYe8uVpXa7L+dIdRyhdt3QiigyK" +
            "JF24PCfO8wVhXcFbi/hWWd1dyv9S8JqyrF3SFAM+NytSXeUPLytozKxd7KjnBdw6Ol3z4bCfxzKsXfnOhNCH/K1eEFUZ/JaLG14Q" +
            "b9VtOndzXhtm/HS+zSVeJhcmYt7QW14pj4gTsQ2XXjD8cPAR8SNeMgQ5UlYWml47kaBjz0u1XkA+1M1VvExeRco4YCVDrl5GBMzw" +
            "mrKsXlNOlRqLp3NeU/rYcvRN7F5Uf3xuLMJGXljz6mX99DReZa4GoW0goF5rgPgXWxWeXndo29KdDWheqphKw41KuV7Sml4N+PMj" +
            "XtQ1HoYumBhe18OhUlYWml7eLFAhAi9gXvLFEwVpsPFe/CgtXE4dLl8FhkJiwBh/Xw3o1s59OHdfGpY0Ns1KCF8cqE54fxa4Xx7E" +
            "p7gBIa1fIX6fcvRN7F8l9p6otuPdXyq/BOGDwOZfLUd02lsNn18+l9cNlejaX0eWa1zkbFRfR+w1uwRE119JFa+w4lpVX057x9y6" +
            "q8ZfWlMO4BS6jF9miunNVbxMX3sOQRKu+3NfiRd3AwbjUV+OQN7FZsDHX46F8LU8n9Zfo2xLVHSL9l/JMC87isW6X9lnBsOyuvpf" +
            "3aViCGwFn1/dvIttMdugX+TxLbTXZwdf/jDhjXmWMGABsCB4XzLFYAiv259U/S1gDi0M4BS6jGAXPrStVQIyYBfMuRKWNJ1gGvPk" +
            "MnQ2zmAb3Y/8losbYCd21fzYT2NgKwo6Wx1weWAzLSQraMysYDWv052T6dxgPNr94t7t3mBqUZLcuqvGYHN/COYkjAFggRo1xWbA" +
            "x2CBN8w/N9DAYJNm/Dh0JktgmRf2XE4dLmCeoyqm65KKYK0o5GaI2GJgrk4Hd5Bwz2DFDUY0oBSOYMU9h8Dn9WFg04vGzVW8TGDZ" +
            "jLzjenFAYNmm2QtQcyhg4Ae9S2+hJGDhrdvwEfEjYOpxA/dy/elhAKIFVyhXk2EqOWmYA4osYWJELtKdDWhhZNLgad9bb2Fq5WuJ" +
            "z44pYWtjkvwAYeRhdQdZ8JqyrGF8HAo6jSNLYY8XNitozKxhlrDuAjIyM2G6XSD8losbYbp33HDkf3phu01RUmHjvmG90sICZ3qU" +
            "YdAfLW3c6HBh15PPsxX9WmHcDEBSVhaaYeM80z87TEZiAvvxWv/cH2IPtg2WbwiLYiFw4s7zBWFibnjMQLYLlmJ8omUY9ws4YoHL" +
            "qFJWFppinM0aCRO4+GKknOPTr4FSYq+OSW2+MJRiwEbTXKzW4mLIzK64ASGtYs/+pai2491i2sak546xmmLmvjHSZvxLYuif3g2V" +
            "6Npi8Z5yXORsVGL4g87cuqvGYwRbFdUWondjEJLwzVW8TGMzH34GsOtYYzhI5dBk2NxjTXRSVHSL9mNzODY34L2zY3am75HPH0pj" +
            "gp1f3LqrxmOHrWkTah20Y475NLiBbw5jqDjoic+OKWOuWT1SYeO+Y7K34qL/BTRjujKXzR9OPWPCpblML/3MY8XllvyWixtj0X7c" +
            "/NhPY2PVEkFXc2hyY9+32p2T6dxj5O3YWNd4NmPm4wTfNOXXY+lXQS8YWipkFFmZ3LqrxmQo16tYBfkhZCsiPMkQyM5kSKsxqpWa" +
            "kWRg3LrskbNVZGh6MjbNSghkbxVNNKAUjmRvRY7Ekf1oZH2Tzc1VvExkg67gB6ZrIWSKD8RHxZkdZIu14vAR8SNkjC53YsfNRWSU" +
            "eQr7HQXwZKB3gzSgFI5ktuq+3aZxqGS50HFgtWG7ZNRBcJgDiixk3Zxb5h4H0GUMTDXHnvVTZRTtco15ljBlFWuZ8QJJz2UfD2Dw" +
            "mrKsZSYkEUWLO2BlOR89K2jMrGVAuPUNMEpIZUDOj4EJmYplQiv/TC/9zGVWtX8Nsf9hZVlqP+gSqL1lax803TZXqmV6JzRqMuBp" +
            "ZXpE/Gj2z7plgZvWr2v1U2WNRNo7kUQ/ZZcMcALEgfBlrQP4XqnkJmW5vhSaGRCSZct46ctI/Vpl6bCfkJbyjmX0f3JpVvx5ZfvJ" +
            "yreOMnBmEZe39qWtjGYTlzh8WWFmZiO6E/CAxS1mJqpsFU0DMWY4QUHsTz3rZjvoeqrcWzxmRtUh/hWg42ZZllBqFCiNZmpO2lkC" +
            "zttmbnI1axl/B2Zy1LW4ASGtZnoGrKi2491mf9fr5oj15WaSp+UNlejaZpsHd3mbs1Fmm6Z5XORsVGaii9XcuqvGZq5jHNjAqn5m" +
            "3SeF+7LTQ2biUOzMutDVZvd8WVR0i/ZnHUA9Qt7VyGcjrMo8KHe3ZzBh+4EJmYpnMbVwD8AVrWdO8bqAvPoUZ1egB2Ruk0FnWcBn" +
            "0mb8S2dcv+mYAO0fZ2TlgncRzztnZTIHNs1KCGdv7Z38losbZ38aSFPJYGtnib/hnZPp3GeUhDOAJa87Z75hoNy6q8ZnyhKBQBjA" +
            "3GfQN3HosjYrZ90bQeyRs1Vn5iMr6JxKcWfysziuP6KYaA2AIqo7UeZoGR1UNKAUjmgZTZW5k+VTaB3IbfyWixtoJ08AQtpMRGgn" +
            "m9TNVbxMaDW96fAR8SNoN7O7XGGgkGg+gRHwHu3baEp/ijSgFI5oVkEVgDwjw2iHpGLic//JaLZUPMtI/VpovvV5gnt+G2i/c6D0" +
            "rFHWaMy4T2nfW29o0CwYQeEzWWjjJ0QraMysaOrA/AmGQkFo6taWgQmZimjvC0xeLOO5aQC9hg2x/2FpA3JG6BKovWkMj1rkl0L0" +
            "aSGtp1zkbFRpK6PdumoNaGk3TOFGj1xUaV/ceYSml25pdM7V5iSMAWl1gPDHnvVTaZO4ppCW8o5pl9D7PzTNwWm7n77y+6WFacjB" +
            "B/5F2+lpzcIa9CrNNGnPPoKE+v47aed7/UpQUD1p8N0oAb+o6mn/YccAE/N9ahGBJ/yWixtqE5ezXKzW4moUVuFkAObwahzcvLgB" +
            "Ia1qKd/y6jL97Go8r+wNlejaakUPfn1Fu1hqRa6AXORsVGpMk9zcuqvGalkjMhOgD9tqaUVbvwqzzmqHL4z/XNtKaoh+SytozKxq" +
            "i6fDn8cyrGqdDguHeb9JaqGEYFR0i/Zqx0hEPzTNwWraagKBCZmKatrONHwb6FVrAFJ/1U9MimsBqA5oGJtIawIr11zkbFRrA8hu" +
            "0mb8S2sGx/CbqvUmaw86DjbNSghrGfWk/JaLG2szx+idk+ncaz6MOoPPt0JraQx1k9JViWtvon0fygT/a3owf06XLTVrkAF/7JGz" +
            "VWuVERZC2kxEa6fCzYYumBhrrAtpGounc2vDVZy9Pe1aa9/F8PAR8SNr39aeudKxjWvhu8JcYaCQa+iJGPPI9eJr9IeRNKAUjmwL" +
            "nx16OkpobBcEsz215OFsKPqcVyhXk2wxrGneyffCbECdE+6oQrNsaP2AhiWGImxq+mZeLOO5bHbAVmnfW29shAt2LxhaKmyHmrhc" +
            "YaCQbJTenYEJmYpsqsWNDbH/YWytek3oEqi9bL+X78JAqDVsy7WuXORsVGzUES9BVXB4bNTGXncRzzts1TAHZmcC2mzVq+S2wAVh" +
            "bOFU6ELlVE1s90W0TC/9zGz9PjpQS+DVbQcG+wP8YxptEjpreF8yxW0aM9SE+v47bSQX8ZxFcONtMDIFzn04d20y8OufVP0tbToD" +
            "q4KjJWltPcCtkJbyjm1B2QJC3tXIbVUmZ9kVJZhtZafF71Gdfm1yyQ4B7+PwbXfKIekstR9thy4zNRKglm2uixNC5VRNbbuJLvyW" +
            "ixttvZ+6WQLO222+XuhgVt7pbcQo+9y6q8Zt0CruMbjsFm3T5/nfNOXXbeA97V/T5idt7xeFckejQ24TTWK7YKvHbiXJLYoNzFdu" +
            "MoZSK2jMrG41gPeEppdubjWvyp/HMqxuRxYSiyPHUG5PeZW+ngIXblHcL9Jm/EtuhHIJgQmZim6XVFC+Z1GObqpahtGlRINuq7AV" +
            "XRqDM26sM95c5GxUbq3QddJm/EtusKoFfBvoVW63dLU9teThbrlCFTbNSghuznMbNs1KCG7mmpdqMuBpbuiUQYd5v0lu8tlP4nP/" +
            "yW7/sgvixahDbwQrh/CasqxvJDiGUkE1PG8umLS8uUbVbzaP0bhSV/tvcSv50h1HKG91To/oEqi9b3pXj+YkjAFvi8PJXGGgkG+T" +
            "+H1cTh0ub5ZhdLsERNdvm2QCExwhr2+ej5g0oBSOb6cmO+ZvsEpvrIZbaVb8eW/btHDbH++7b+ccbROgD9tv6qUa8lJKum/qsyov" +
            "GFoqb+9EjnL0TexwB9FYNvwrEXAMGKdrlRM+cBCX9ytozKxwFYWn3LqrxnAVteSiNpl6cCDIXWnfW29wKxVfzn04d3A8UV+F4zec" +
            "cD7mpIEJmYpwQVrVUYvR5XBUzZQNsf9hcFXnF6pOEHFwV4JU6BKovXBgUaVJRnKWcGmf9sXqsDxwc9NtjlTm73B1vbVc5GxUcHXy" +
            "28OyuvpweXzBUEvg1XB/OA5ivPrTcIf75RqLp3Nwl88n2CNOpnCopqNCwii3cLEPAgBSWxNwvEJyfAk6zHDDgv2D2tu3cNz48qL/" +
            "BTRw58i0kJbyjnDr4Qk34L2zcQ+vzOunlXdxHNEV9vHL23EfYa9KoRiEcR9qxUqhGIRxIdIo7Na9JnExNjo1EqCWcUAYON/ampxx" +
            "QidzAb+o6nFLEflPdd6rcViTGkaPXFRxYg0/gMk8pnFlkTX8losbcWenwWQA5vBxbpyHDZXo2nF98ADi3u3ecZQC2Q8ieRFxmR+M" +
            "dfGrSnG3YHfSHUcocb1VacZew9xx3I5ZK2jMrHHft9GfxzKsce0VY6bAhHhx8R4ZgCWvO3H75DbSZvxLcg5kt+gSqL1yLnoQgQmZ" +
            "inI6Hxj3XuwscjqSB6NBioNyVGKN3KNcmHJVuBxgxIs6clY75VzkbFRyV9h80mb8S3JfV++52H77cmNKHDbNSghyba6ByBweI3J4" +
            "eyI2zUoIco/Kay3ILLZykKKebdzocHKSnEiLI8dQcpzhVuYeB9ByqboS5m+wSnKr/76qFScQcq4zjvCasqxyuuwi8YQq23LAy/um" +
            "25zlcs5AjUdDHSdy07Zjt7ZqznLsid2hRt9ncwR0hby5RtVzH1aW6BKovXMtdti6m7yRcy9J7bm2/61zMKu/7E8963M1y9BcYaCQ" +
            "c1EuQuLFqENzlK0h9fxSwXO2IK5n6ws3c7qf/itozKxzv42u3LqrxnPK0GRp31tvc+ZZZoI5L5Vz8c+jZf30NHP/7x6t+Bh4dAAN" +
            "+OxPPet0CJUzn8cyrHQNtpcraMysdBOn/brsmCd0H8W8XORsVHQf+uLDsrr6dCAwFZ/HMqx0IGAlVnna9XQpQBVtuxLodCxi/1BL" +
            "4NV0Uq6qRmwwvnRbFwkLUHModFxa82gYm0h0Zkp5cQsit3RrOldxQ79mdHEWTrGOLL50fAJ/bZm3X3SHAPmYAO0fdJXpEDuKxbp0" +
            "xtkc+pvT4nTMk3eotuPddNJlT7eOMnB008KHV3NocnTbPkE1EqCWdOPVL+Jz/8l07C96/hWg43UAZBeScYvqdQKbITuRRD91DBVG" +
            "fR80n3UPmTz8losbdQ/z8wIqQJt1Ea/IYFbe6XUZ3V+dk+ncdUAHZ2Ruk0F1Z11wwrS71XVofgIGRMbsdWmcutWQA1l1hpZgK2jM" +
            "rHWJv9ifxzKsdYziuUwv/cx1lx1qoxZ8cXWbJiCDz7dCdZ8RpR4weM91pew90mb8S3WnmoCRzx9KdbhsvugSqL11wIkL8gO6SXXH" +
            "s+2ezy13dcwLOFcoV5N1zKFbRQN7qXXjxJ/GXsPcdeSaDqbrkop15Y2nXGGgkHXl2ufoEqi9dff2aC8YWip1+pNL8lJKunX+apTY" +
            "+VSRdgBD7FzkbFR2CV/2vYKHAnYigyk2zUoIdic4BxKWNJ12KR1Y06+BUnY50nIqHiSvdjqqpWLe0Ft2Qt6lcvRN7HZG449Ri9Hl" +
            "dkbpXdsf77t2U8IZ6hm4UXZYO5XwmrKsdmrUAqqFpOx2eEiUSu0lLnZ9vmq0DGLHdohcP7sERNd2nBkrhiWGInaeCc+QlvKOdqF6" +
            "o06XLTV2yV6d6BKovXbgu54ZV/V8du9ubkC2C5Z2+zZJ7cPAWHb8F4w9HztKdwizF32P1YV3E4zKJq+X/Hc+tSj5plrId05BX/x4" +
            "B5x3YCi1cukjTHdi4quC55Bgd2SoBStozKx3aZW13Lqrxndt1Dl6Okpod4gfzNOvgVJ3kGFtfo8njneb16piU+wtd6n3JaL6AGN3" +
            "sp06n8cyrHe3vp4raMysd72wBL6WoC53ygLpw7K6+nfPxJ7Hdh8hd8/3A89CVYt300gcahEK4Xf8trFKFjjFd/2H2/CAxS14BR8Q" +
            "B6ZrIXgGYvpkbpNBeBBSgHS1Kr54FUJebZm3X3gmCoZxQ79meC1KdBOgD9t4MQkAm6r1JnhMPJfOOGsYeHabfqi24914ewy7byr/" +
            "fnh9yo5TyWBreIVGSDUSoJZ4jd025h4H0HiWN4EJE7j4eKpsHo7Hg+N4rKMoPztMRnizZE250rGNeLYdTYgdTLR4ufv6BdRIonjC" +
            "RXRtMdugeMPlZp2T6dx46g9uaBibSHkIModrsC2teQx5Rfu0BD15QSVxn2x0anlDVUDcuqvGeU/0RNJm/Et5YX9kA527S3lidMXo" +
            "Eqi9eWqREvWtwlB5crLjNRKglnl6Saiu7Pv+eY3MpsK0u9V5jqIVqpWakXmPla5cYaCQeY/i7ugSqL15km0bbb4wlHmTlZdc5GxU" +
            "eZQbC0rtJS55lZlvahEK4Xmkm1LuqEKzeaxCT8qOYxF5sFZbeKK2HnmzZ/3BLI8JebiYbXlUoVJ5zIswNs1KCHnj2nk1HDzEeeSy" +
            "rGaI2GJ58PFk3sn3wnn9yiDtw8BYegJDnPCasqx6AtFMAhkZyHoMB4G7BETXehTcCZ+HjNd6JJMclqlQDnolhmsPwBWteifGcb8K" +
            "etx6Os/rePgsVXpGITKCe34bekuCqlJBNTx6T3TMSUZylnpSRNubqvUmellHN72ChwJ6c2ak6BKovXqlPlDqGbhReqpHIq1oiqB6" +
            "9hXjXGGgkHr4SWb4zf+VewowvG8/G0V7DrAMK2jMrHsTnbzcuqvGezHNMzwod7d7Oml0euUfh3tF37FeqeQme1P/LKakCGp7XKVB" +
            "n8cyrHthxqUraMyse3QK8MOyuvp7eWYvlhuT8XuAjaqCbBdUe4Ujt30fNJ97lYSzZm9tV3umvrhNwEDMe6eP4vQqzTR7sGsBYMSL" +
            "Onuw9bYToA/be7e3V2lW/Hl7v0pleJfPdHvFDDPbw30me88Oy/xO86F70BKNdO3HbXvh9p7ZFSWYe/ZEnsqOYxF8IKOFqLbj3Xwk" +
            "x8N26iMxfCfSlV7HeIB8N+U92x/vu3xAP4gFabDxfFOjZlGL0eV8VHQlmcWb+HxgJVSEc0StfGQEAQl+UKl8be1tnZPp3Hxx4mh3" +
            "Ec87fH8PQ0lGcpZ8g6P5xhkl83yUF3VdGoMzfMOYT5gDiix83raj44bYeXzoLTimtjQ2fOsteJvCbGN9CoC2/UHEbH0MfMzoEqi9" +
            "fRSZGeqvqjt9HLrqNRKgln031K2/CrPOfTiqHK4/oph9OZ21XGGgkH056vXoEqi9fTx1ImoUKI19PZ2eXORsVH0+IxJHQx0nfT+h" +
            "dm27Euh9TqNZ+aZayH1WSlbOOGsYfV1wBMTWlxB9Z0QVAsSB8H2BkVJt3JhUfYQOmBqLp3N9jeKAMXI0vX2SvNXOfTh3faWnsdOv" +
            "gVJ9spCUzn04d32+5BCjMZTefb8/M6i24919z45yE2odtH3Rzni7YHLVfeTX8nj4LFV98Ck5jXmWMH31irFHQx0nffxM4pgA7R9+" +
            "ATWYAhkZyH4DTz652H77fglij3Oo2Jd+CpRJ2CNOpn4Lu1mtaIqgfkshV9jAqn5+W37vAtfS7X5cKJOYA4osfmbi+2oUKI1+oB3q" +
            "XGGgkH6iUW31I/eOfq6L26brkop+wQRjn8cyrH7kAbd6Okpofumz6dC10pV+7+e4Wv/cH38GrUifxzKsfwvOrCtozKx/D/3O1ZAD" +
            "WX8jbjaZxZv4fy8rvoDJPKZ/P4y6ahl1Xn9G7kf9QcRsf1GX6ekstR9/WLehXORsVH9acwhdGoMzf2lSbHTtx21/bxQ62Bl1H396" +
            "GpR4l890f6BMpcbkWwp/yExxA527S3/Kq4yotuPdf9HanFsdcHl/2g4InEaGOH/h7UTeyffCf/JTuKxMOb5//nwslhuT8Q==";
    private static final Int2IntMap ALIASES = readAliases();
    private static final Set<BlockStateRewriter> INSTALLED = Collections.newSetFromMap(new WeakHashMap<>());

    private BedrockBlockStateCompatibility() {
    }

    public static synchronized void install(final BlockStateRewriter rewriter) {
        if (!INSTALLED.add(rewriter)) return;

        try {
            final Int2IntMap javaIds = intMapField(rewriter, "blockStateIdMappings");
            final Int2ObjectMap<String> tags = objectMapField(rewriter, "blockStateTags");
            int installed = 0;
            for (Int2IntMap.Entry alias : ALIASES.int2IntEntrySet()) {
                final int localId = alias.getIntValue();
                final int javaId = javaIds.get(localId);
                if (javaId == -1) continue;

                javaIds.put(alias.getIntKey(), javaId);
                if (tags.containsKey(localId)) tags.put(alias.getIntKey(), tags.get(localId));
                installed++;
            }
            ViaBedrock.getPlatform().getLogger().log(Level.INFO,
                    "Installed " + installed + " Bedrock 1.26.50 block-state compatibility aliases");
        } catch (ReflectiveOperationException | RuntimeException e) {
            INSTALLED.remove(rewriter);
            ViaBedrock.getPlatform().getLogger().log(Level.WARNING,
                    "Could not install Bedrock 1.26.50 block-state compatibility aliases", e);
        }
    }

    static int aliasCount() {
        return ALIASES.size();
    }

    static int localId(final int bedrockBlockStateId) {
        return ALIASES.getOrDefault(bedrockBlockStateId, bedrockBlockStateId);
    }

    static String computedAliasDataSha256() {
        return sha256(Base64.getDecoder().decode(ALIASES_BASE64));
    }

    @SuppressWarnings("unchecked")
    private static Int2ObjectMap<String> objectMapField(final BlockStateRewriter rewriter, final String name)
            throws ReflectiveOperationException {
        final Field field = BlockStateRewriter.class.getDeclaredField(name);
        field.setAccessible(true);
        return (Int2ObjectMap<String>) field.get(rewriter);
    }

    private static Int2IntMap intMapField(final BlockStateRewriter rewriter, final String name)
            throws ReflectiveOperationException {
        final Field field = BlockStateRewriter.class.getDeclaredField(name);
        field.setAccessible(true);
        return (Int2IntMap) field.get(rewriter);
    }

    private static Int2IntMap readAliases() {
        final byte[] bytes = Base64.getDecoder().decode(ALIASES_BASE64);
        if (bytes.length != EXPECTED_ALIAS_COUNT * 8) {
            throw new IllegalStateException("Invalid Bedrock block-state compatibility alias data");
        }
        final String actualSha256 = sha256(bytes);
        if (!ALIAS_DATA_SHA256.equals(actualSha256)) {
            throw new IllegalStateException("Bedrock block-state compatibility alias digest mismatch: " + actualSha256);
        }

        final Int2IntMap aliases = new Int2IntOpenHashMap(EXPECTED_ALIAS_COUNT);
        final ByteBuffer buffer = ByteBuffer.wrap(bytes);
        while (buffer.hasRemaining()) aliases.put(buffer.getInt(), buffer.getInt());
        return aliases;
    }

    private static String sha256(final byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is unavailable", e);
        }
    }
}
