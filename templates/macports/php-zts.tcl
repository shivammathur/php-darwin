
# php-darwin keeps this downstream-only variant in its private ports tree.
if {${subport} eq ${php}} {
    variant zts description {Enable Zend thread safety} {
        configure.args-append --enable-zts
    }
}
