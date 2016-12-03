module.exports = function(grunt) {

    grunt.loadNpmTasks("grunt-mocha-cli");

    grunt.initConfig({
        mochacli: {
            options: {
                bail: true
            },
            all: ['test/*.js']
        }
    });
    grunt.registerTask("test", ["mochacli"]);

    grunt.registerTask("default", []);
};